package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 云备份后端测试覆盖 provider 级策略、write-only credential 和 manifest 校验，避免 WebDAV/S3 运行面漂移。
func TestCloudBackupConfigValidationRejectsUnsafeRemotePaths(t *testing.T) {
	webdav := cloudBackupWebDAVSettings{
		URL:  "https://dav.example.com/remote.php/dav/files/alice",
		Path: "../renewlet",
	}
	if err := webdav.NormalizeAndValidate(); err == nil {
		t.Fatal("expected WebDAV parent path to be rejected")
	}

	s3 := cloudBackupS3Settings{
		Endpoint:    "https://storage.example.com",
		Bucket:      "renewlet",
		Prefix:      "snapshots/..",
		AccessKeyID: "access",
	}
	if err := s3.NormalizeAndValidate(); err == nil {
		t.Fatal("expected S3 parent prefix to be rejected")
	}
}

func TestCloudBackupSnapshotSourceCanReopenAndCleanup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "snapshot.zip")
	content := []byte("renewlet snapshot")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	source := cloudBackupSnapshotSource{path: path, size: int64(len(content))}

	for attempt := 0; attempt < 2; attempt++ {
		reader, err := source.Open()
		if err != nil {
			t.Fatalf("open attempt %d failed: %v", attempt+1, err)
		}
		actual, readErr := io.ReadAll(reader)
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil {
			t.Fatalf("read attempt %d failed: read=%v close=%v", attempt+1, readErr, closeErr)
		}
		if string(actual) != string(content) {
			t.Fatalf("open attempt %d read %q, want %q", attempt+1, actual, content)
		}
	}

	if err := source.Cleanup(); err != nil {
		t.Fatalf("cleanup failed: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected temporary snapshot to be removed, got %v", err)
	}
}

func TestWithCloudBackupSnapshotPayloadAlwaysCleansTemporaryFile(t *testing.T) {
	for _, test := range []struct {
		name   string
		useErr error
	}{
		{name: "success"},
		{name: "upload failure", useErr: errors.New("upload failed")},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "snapshot.zip")
			if err := os.WriteFile(path, []byte("snapshot"), 0o600); err != nil {
				t.Fatal(err)
			}
			payload := cloudBackupSnapshotPayload{Source: cloudBackupSnapshotSource{path: path, size: 8}}

			err := withCloudBackupSnapshotPayload("usr_cloud", payload, func(cloudBackupSnapshotPayload) error {
				return test.useErr
			})
			if !errors.Is(err, test.useErr) {
				t.Fatalf("use error = %v, want %v", err, test.useErr)
			}
			if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("expected temporary snapshot to be removed, got %v", statErr)
			}
		})
	}
}

func TestCloudBackupConfigValidationRequiresExplicitS3SigningRegion(t *testing.T) {
	// SigV4 credential scope 包含 region；这里阻断空值，避免后续 SDK 静默用错误 region 签名后才暴露 SignatureDoesNotMatch。
	s3 := cloudBackupS3Settings{
		Endpoint:    "https://storage.example.com",
		Region:      "",
		Bucket:      "renewlet",
		Prefix:      "snapshots",
		AccessKeyID: "access",
	}
	if err := s3.NormalizeAndValidate(); err == nil || err.Error() != "CLOUD_BACKUP_S3_REGION_REQUIRED" {
		t.Fatalf("expected missing signing region to be rejected before remote access, got %v", err)
	}

	s3.Region = "auto"
	if err := s3.NormalizeAndValidate(); err != nil {
		t.Fatalf("expected documented signing region value to be accepted, got %v", err)
	}
}

func TestCloudBackupConfigDTORedactsCredential(t *testing.T) {
	config := cloudBackupResolvedConfig{
		UserID:   "usr_cloud",
		Provider: cloudBackupProviderS3,
		Targets: map[string]cloudBackupResolvedTarget{
			cloudBackupProviderWebDAV: {
				UserID:     "usr_cloud",
				Provider:   cloudBackupProviderWebDAV,
				WebDAV:     &cloudBackupWebDAVSettings{URL: "https://dav.example.com/remote.php/dav/files/alice", Username: "alice", Path: "renewlet"},
				Credential: cloudBackupStoredCredential{WebDAVPassword: "webdav-secret"},
				Policy:     cloudBackupPolicy{ScheduleFrequency: "daily", ScheduleTime: "02:00", ScheduleWeekday: "monday", Retention: 3},
				LastStatus: cloudBackupStatusIdle,
			},
			cloudBackupProviderS3: {
				UserID:     "usr_cloud",
				Provider:   cloudBackupProviderS3,
				S3:         &cloudBackupS3Settings{Endpoint: "https://storage.example.com", Region: "auto", Bucket: "renewlet", AccessKeyID: "access"},
				Credential: cloudBackupStoredCredential{S3SecretAccessKey: "plain-secret"},
				Policy:     cloudBackupPolicy{ScheduleFrequency: "weekly", ScheduleTime: "04:30", ScheduleWeekday: "friday", Retention: 9},
				LastStatus: cloudBackupStatusSuccess,
			},
		},
	}

	dto := config.DTO()
	if !dto.CredentialSet {
		t.Fatal("expected credentialSet to be true")
	}
	if dto.S3 == nil || dto.S3.AccessKeyID != "access" {
		t.Fatalf("expected non-secret S3 config to remain, got %#v", dto.S3)
	}
	if !dto.CredentialSetByProvider.WebDAV || !dto.CredentialSetByProvider.S3 {
		t.Fatalf("expected both provider credential states to be true, got %#v", dto.CredentialSetByProvider)
	}
	if dto.PolicyByProvider.WebDAV.Retention != 3 || dto.PolicyByProvider.S3.Retention != 9 {
		t.Fatalf("expected provider policies to stay independent, got %#v", dto.PolicyByProvider)
	}
}

func TestCloudBackupUpdateMergesBothProviderConfigsAndWriteOnlyCredentials(t *testing.T) {
	currentWebDAV := cloudBackupResolvedTarget{
		UserID:     "usr_cloud",
		Provider:   cloudBackupProviderWebDAV,
		WebDAV:     &cloudBackupWebDAVSettings{URL: "https://dav.example.com/remote.php/dav/files/alice", Username: "alice", Path: "renewlet"},
		Credential: cloudBackupStoredCredential{WebDAVPassword: "webdav-secret"},
		Policy:     cloudBackupPolicy{ScheduleFrequency: "daily", ScheduleTime: "03:00", ScheduleWeekday: "monday", Retention: cloudBackupDefaultRetention},
		LastStatus: cloudBackupStatusIdle,
	}
	s3Secret := "new-s3-secret"
	ignoredWebDAVSecret := "ignored-webdav-secret"
	nextS3 := targetFromCloudBackupUpdate("usr_cloud", cloudBackupConfigUpdateRequest{
		Provider: cloudBackupProviderS3,
		WebDAV:   &cloudBackupWebDAVSettings{URL: "https://dav.example.com/remote.php/dav/files/ignored", Username: "ignored", Path: "ignored"},
		S3:       &cloudBackupS3Settings{Endpoint: "https://storage.example.com", Region: "us-east-1", Bucket: "renewlet", Prefix: "snapshots", AccessKeyID: "access"},
		Credentials: &cloudBackupCredentialPayload{
			WebDAVPassword:    &ignoredWebDAVSecret,
			S3SecretAccessKey: &s3Secret,
		},
		Policy: cloudBackupPolicy{ScheduleEnabled: true, ScheduleFrequency: "weekly", ScheduleTime: "04:30", ScheduleWeekday: "friday", Retention: 9},
	}, defaultCloudBackupTarget("usr_cloud", cloudBackupProviderS3))

	if nextS3.WebDAV != nil {
		t.Fatalf("expected S3 target row to store only S3 config, got WebDAV=%#v", nextS3.WebDAV)
	}
	if nextS3.S3 == nil || nextS3.S3.Bucket != "renewlet" {
		t.Fatalf("expected S3 config to be saved, got %#v", nextS3.S3)
	}
	if nextS3.Credential.WebDAVPassword != "" || nextS3.Credential.S3SecretAccessKey != "new-s3-secret" {
		t.Fatalf("expected S3 row to ignore WebDAV secret and save S3 secret, got %#v", nextS3.Credential)
	}
	if currentWebDAV.Credential.WebDAVPassword != "webdav-secret" || currentWebDAV.WebDAV.Username != "alice" {
		t.Fatalf("expected WebDAV target to remain independent, got %#v", currentWebDAV)
	}

	emptyWebDAVSecret := ""
	ignoredS3Secret := "ignored-s3-secret"
	backToWebDAV := targetFromCloudBackupUpdate("usr_cloud", cloudBackupConfigUpdateRequest{
		Provider: cloudBackupProviderWebDAV,
		WebDAV:   &cloudBackupWebDAVSettings{URL: "https://dav.example.com/remote.php/dav/files/bob", Username: "bob", Path: "renewlet"},
		S3:       &cloudBackupS3Settings{Endpoint: "https://storage.example.com", Region: "us-east-1", Bucket: "ignored", Prefix: "ignored", AccessKeyID: "ignored"},
		Credentials: &cloudBackupCredentialPayload{
			WebDAVPassword:    &emptyWebDAVSecret,
			S3SecretAccessKey: &ignoredS3Secret,
		},
		Policy: cloudBackupPolicy{ScheduleFrequency: "daily", ScheduleTime: "02:15", ScheduleWeekday: "monday", Retention: 5},
	}, currentWebDAV)

	if backToWebDAV.S3 != nil {
		t.Fatalf("expected WebDAV target row to store only WebDAV config, got S3=%#v", backToWebDAV.S3)
	}
	if backToWebDAV.WebDAV == nil || backToWebDAV.WebDAV.Username != "bob" {
		t.Fatalf("expected WebDAV config to update, got %#v", backToWebDAV.WebDAV)
	}
	if backToWebDAV.Credential.WebDAVPassword != "webdav-secret" || backToWebDAV.Credential.S3SecretAccessKey != "" {
		t.Fatalf("expected empty WebDAV secret to keep existing provider credential only, got %#v", backToWebDAV.Credential)
	}
	if nextS3.Credential.S3SecretAccessKey != "new-s3-secret" || nextS3.S3.Bucket != "renewlet" {
		t.Fatalf("expected S3 target to remain independent after WebDAV save, got %#v", nextS3)
	}
}

func TestCloudBackupTargetDueUsesProviderPolicyTimeWeekdayAndTimezone(t *testing.T) {
	daily := defaultCloudBackupTarget("usr_cloud", cloudBackupProviderWebDAV)
	daily.Policy = cloudBackupPolicy{
		ScheduleEnabled:   true,
		ScheduleFrequency: "daily",
		ScheduleTime:      "03:00",
		ScheduleWeekday:   "monday",
		Retention:         7,
	}
	if !cloudBackupTargetDue(daily, "Asia/Shanghai", time.Date(2026, 6, 9, 19, 1, 0, 0, time.UTC)) {
		t.Fatal("expected daily target to be due after 03:00 in user timezone")
	}
	daily.LastBackupAt = "2026-06-09T19:00:00.000Z"
	if cloudBackupTargetDue(daily, "Asia/Shanghai", time.Date(2026, 6, 9, 19, 1, 0, 0, time.UTC)) {
		t.Fatal("expected daily target not to rerun after same scheduled instant")
	}

	weekly := defaultCloudBackupTarget("usr_cloud", cloudBackupProviderS3)
	weekly.Policy = cloudBackupPolicy{
		ScheduleEnabled:   true,
		ScheduleFrequency: "weekly",
		ScheduleTime:      "03:00",
		ScheduleWeekday:   "wednesday",
		Retention:         7,
	}
	weekly.LastBackupAt = "2026-06-02T19:00:00.000Z"
	if cloudBackupTargetDue(weekly, "Asia/Shanghai", time.Date(2026, 6, 9, 18, 59, 0, 0, time.UTC)) {
		t.Fatal("expected weekly target not to run before configured weekday")
	}
	if !cloudBackupTargetDue(weekly, "Asia/Shanghai", time.Date(2026, 6, 10, 19, 1, 0, 0, time.UTC)) {
		t.Fatal("expected weekly target to run after configured weekday and time")
	}
}

func TestVerifyCloudBackupSnapshotBytesRejectsChecksumMismatch(t *testing.T) {
	content := []byte("renewlet")
	sum := sha256.Sum256([]byte("other"))
	manifest := cloudBackupSnapshotManifest{
		Kind:          "renewlet-cloud-backup-snapshot",
		SchemaVersion: 1,
		SizeBytes:     int64(len(content)),
		SHA256:        hex.EncodeToString(sum[:]),
	}

	if err := verifyCloudBackupSnapshotBytes(content, manifest); err == nil {
		t.Fatal("expected checksum mismatch to be rejected")
	}
}

func TestVerifyCloudBackupSnapshotBytesEnforcesUnifiedSnapshotLimit(t *testing.T) {
	content := make([]byte, int(cloudBackupSnapshotMaxBytes)+1)
	allowed := content[:159*(1<<20)/10]
	allowedHash := sha256.Sum256(allowed)
	allowedManifest := cloudBackupSnapshotManifest{
		Kind:                "renewlet-cloud-backup-snapshot",
		SchemaVersion:       cloudBackupTransportSchemaVersion,
		SizeBytes:           int64(len(allowed)),
		SHA256:              hex.EncodeToString(allowedHash[:]),
		ExportKind:          "renewlet-export",
		ExportSchemaVersion: renewletExportSchemaVersion,
	}
	if err := verifyCloudBackupSnapshotBytes(allowed, allowedManifest); err != nil {
		t.Fatalf("expected 15.9 MiB snapshot to pass, got %v", err)
	}

	tooLarge := content
	tooLargeManifest := cloudBackupSnapshotManifest{
		Kind:          "renewlet-cloud-backup-snapshot",
		SchemaVersion: 1,
		SizeBytes:     int64(len(tooLarge)),
		SHA256:        "not-evaluated-before-size-check",
	}
	if err := verifyCloudBackupSnapshotBytes(tooLarge, tooLargeManifest); err == nil || err.Error() != "CLOUD_BACKUP_SNAPSHOT_TOO_LARGE" {
		t.Fatalf("expected snapshot above 16 MiB to fail before restore, got %v", err)
	}
}

func TestCloudBackupProviderFromRequestRequiresExplicitProviderForList(t *testing.T) {
	provider, hasProvider, err := cloudBackupProviderFromRequest(httptest.NewRequest(http.MethodGet, "/api/app/cloud-backups", nil))
	if err != nil || hasProvider || provider != "" {
		t.Fatalf("expected missing provider to stay explicit for list handler, provider=%q has=%v err=%v", provider, hasProvider, err)
	}

	provider, hasProvider, err = cloudBackupProviderFromRequest(httptest.NewRequest(http.MethodGet, "/api/app/cloud-backups?provider=s3", nil))
	if err != nil || !hasProvider || provider != cloudBackupProviderS3 {
		t.Fatalf("expected S3 provider, provider=%q has=%v err=%v", provider, hasProvider, err)
	}

	_, hasProvider, err = cloudBackupProviderFromRequest(httptest.NewRequest(http.MethodGet, "/api/app/cloud-backups?provider=dropbox", nil))
	if err == nil || !hasProvider {
		t.Fatalf("expected invalid explicit provider to fail, has=%v err=%v", hasProvider, err)
	}
}

func TestCloudBackupRemoteTargetForProviderDoesNotInspectOtherProvider(t *testing.T) {
	config := cloudBackupResolvedConfig{
		UserID:   "usr_cloud",
		Provider: cloudBackupProviderWebDAV,
		Targets: map[string]cloudBackupResolvedTarget{
			cloudBackupProviderWebDAV: {
				UserID:     "usr_cloud",
				Provider:   cloudBackupProviderWebDAV,
				WebDAV:     &cloudBackupWebDAVSettings{URL: "https://dav.example.com/remote.php/dav/files/alice", Username: "alice", Path: "renewlet"},
				Credential: cloudBackupStoredCredential{WebDAVPassword: "webdav-secret"},
				Policy:     defaultCloudBackupPolicy(),
				LastStatus: cloudBackupStatusIdle,
			},
			cloudBackupProviderS3: {
				UserID:     "usr_cloud",
				Provider:   cloudBackupProviderS3,
				S3:         &cloudBackupS3Settings{Endpoint: "https://storage.example.com", Region: "auto", Bucket: "renewlet", AccessKeyID: "access"},
				Credential: cloudBackupStoredCredential{},
				Policy:     defaultCloudBackupPolicy(),
				LastStatus: cloudBackupStatusIdle,
			},
		},
	}

	target, err := cloudBackupRemoteTargetForProvider(config, cloudBackupProviderWebDAV)
	if err != nil {
		t.Fatalf("expected WebDAV target even when S3 is incomplete: %v", err)
	}
	if target.Provider != cloudBackupProviderWebDAV {
		t.Fatalf("expected WebDAV target, got %s", target.Provider)
	}

	if _, err := cloudBackupRemoteTargetForProvider(config, cloudBackupProviderS3); err == nil {
		t.Fatal("expected S3 target to fail independently")
	}
}

func TestDownloadCloudBackupSnapshotFromTargetsFallsBackAndAggregatesRawFailures(t *testing.T) {
	id := "renewlet-export-v1-20260609T000000Z-abcd1234"
	content := []byte("renewlet")
	s3 := &fakeCloudBackupRemoteClient{
		downloadContent:  content,
		downloadManifest: cloudBackupManifestForTest(id, content),
	}
	got, manifest, err := downloadCloudBackupSnapshotFromTargets(context.Background(), []cloudBackupTarget{
		{Provider: cloudBackupProviderWebDAV, Client: &fakeCloudBackupRemoteClient{downloadErr: cloudBackupHTTPErrorForTest("CLOUD_BACKUP_WEBDAV_NOT_FOUND", http.StatusNotFound, "<d:error>missing</d:error>")}},
		{Provider: cloudBackupProviderS3, Client: s3},
	}, id)
	if err != nil {
		t.Fatalf("expected S3 fallback to succeed: %v", err)
	}
	if string(got) != string(content) || manifest.ID != id {
		t.Fatalf("unexpected fallback download result: %q %#v", got, manifest)
	}

	_, _, err = downloadCloudBackupSnapshotFromTargets(context.Background(), []cloudBackupTarget{
		{Provider: cloudBackupProviderWebDAV, Client: &fakeCloudBackupRemoteClient{downloadErr: cloudBackupHTTPErrorForTest("CLOUD_BACKUP_WEBDAV_NOT_FOUND", http.StatusNotFound, "<d:error>missing</d:error>")}},
		{Provider: cloudBackupProviderS3, Client: &fakeCloudBackupRemoteClient{downloadErr: cloudBackupHTTPErrorForTest("CLOUD_BACKUP_S3_GET_FAILED", http.StatusForbidden, "<Error><Code>AccessDenied</Code></Error>")}},
	}, id)
	remoteErr := cloudBackupRemoteErrorFrom(err)
	if remoteErr == nil || remoteErr.details == nil || remoteErr.details.RawResponseText == nil {
		t.Fatalf("expected raw provider attempt summary, got %#v", err)
	}
	if !strings.Contains(*remoteErr.details.RawResponseText, "webdav: CLOUD_BACKUP_WEBDAV_NOT_FOUND") {
		t.Fatalf("expected WebDAV failure summary, got %#v", *remoteErr.details.RawResponseText)
	}
	if !strings.Contains(*remoteErr.details.RawResponseText, "s3: CLOUD_BACKUP_S3_GET_FAILED") || !strings.Contains(*remoteErr.details.RawResponseText, "AccessDenied") {
		t.Fatalf("expected S3 failure summary, got %#v", *remoteErr.details.RawResponseText)
	}
}

func TestDeleteCloudBackupSnapshotFromTargetsRequiresProviderForAmbiguousMatches(t *testing.T) {
	id := "renewlet-export-v1-20260609T000000Z-abcd1234"
	manifest := cloudBackupManifestForTest(id, []byte("renewlet"))
	webdav := &fakeCloudBackupRemoteClient{listManifests: []cloudBackupSnapshotManifest{manifest}}
	s3 := &fakeCloudBackupRemoteClient{listManifests: []cloudBackupSnapshotManifest{manifest}}

	err := deleteCloudBackupSnapshotFromTargets(context.Background(), []cloudBackupTarget{
		{Provider: cloudBackupProviderWebDAV, Client: webdav},
		{Provider: cloudBackupProviderS3, Client: s3},
	}, id)

	remoteErr := cloudBackupRemoteErrorFrom(err)
	if remoteErr == nil || remoteErr.code != "CLOUD_BACKUP_PROVIDER_REQUIRED" {
		t.Fatalf("expected provider required error, got %#v", err)
	}
	if webdav.deleted || s3.deleted {
		t.Fatal("ambiguous delete must not delete any provider")
	}
}

func TestDeleteCloudBackupSnapshotFromTargetsDeletesOnlyUniqueMatch(t *testing.T) {
	id := "renewlet-export-v1-20260609T000000Z-abcd1234"
	webdav := &fakeCloudBackupRemoteClient{listManifests: []cloudBackupSnapshotManifest{cloudBackupManifestForTest(id, []byte("renewlet"))}}
	s3 := &fakeCloudBackupRemoteClient{}

	err := deleteCloudBackupSnapshotFromTargets(context.Background(), []cloudBackupTarget{
		{Provider: cloudBackupProviderWebDAV, Client: webdav},
		{Provider: cloudBackupProviderS3, Client: s3},
	}, id)

	if err != nil {
		t.Fatalf("expected unique delete to succeed: %v", err)
	}
	if !webdav.deleted || s3.deleted {
		t.Fatalf("expected only WebDAV delete, webdav=%v s3=%v", webdav.deleted, s3.deleted)
	}
}

type fakeCloudBackupRemoteClient struct {
	listManifests    []cloudBackupSnapshotManifest
	listErr          error
	downloadContent  []byte
	downloadManifest cloudBackupSnapshotManifest
	downloadErr      error
	deleteErr        error
	deleted          bool
}

func (client *fakeCloudBackupRemoteClient) Test(ctx context.Context) error {
	return nil
}

func (client *fakeCloudBackupRemoteClient) List(ctx context.Context) ([]cloudBackupSnapshotManifest, error) {
	if client.listErr != nil {
		return nil, client.listErr
	}
	return client.listManifests, nil
}

func (client *fakeCloudBackupRemoteClient) Upload(ctx context.Context, filename string, source cloudBackupSnapshotSource, manifest cloudBackupSnapshotManifest) error {
	return nil
}

func cloudBackupSnapshotSourceForTest(t *testing.T, content []byte) cloudBackupSnapshotSource {
	t.Helper()
	path := filepath.Join(t.TempDir(), "snapshot.zip")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	return cloudBackupSnapshotSource{path: path, size: int64(len(content))}
}

func (client *fakeCloudBackupRemoteClient) Download(ctx context.Context, id string) ([]byte, cloudBackupSnapshotManifest, error) {
	if client.downloadErr != nil {
		return nil, cloudBackupSnapshotManifest{}, client.downloadErr
	}
	return client.downloadContent, client.downloadManifest, nil
}

func (client *fakeCloudBackupRemoteClient) Delete(ctx context.Context, id string) error {
	if client.deleteErr != nil {
		return client.deleteErr
	}
	client.deleted = true
	return nil
}

func cloudBackupManifestForTest(id string, content []byte) cloudBackupSnapshotManifest {
	sum := sha256.Sum256(content)
	return cloudBackupSnapshotManifest{
		Kind:                "renewlet-cloud-backup-snapshot",
		SchemaVersion:       cloudBackupTransportSchemaVersion,
		ID:                  id,
		Filename:            id + ".zip",
		CreatedAt:           "2026-06-09T00:00:00.000Z",
		SizeBytes:           int64(len(content)),
		SHA256:              hex.EncodeToString(sum[:]),
		ExportKind:          "renewlet-export",
		ExportSchemaVersion: renewletExportSchemaVersion,
	}
}

func cloudBackupHTTPErrorForTest(code string, status int, body string) error {
	return cloudBackupRemoteHTTPError(code, &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     http.Header{"content-type": []string{"application/xml"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	})
}
