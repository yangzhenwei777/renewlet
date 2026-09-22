package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func (r *cloudBackupConfigUpdateRequest) Validate(locale appLocale) error {
	r.Provider = strings.TrimSpace(r.Provider)
	if err := r.Policy.NormalizeAndValidate(locale); err != nil {
		return err
	}
	switch r.Provider {
	case cloudBackupProviderWebDAV:
		if r.WebDAV == nil {
			return errors.New(serverText(locale, "cloudBackup.webdavRequired"))
		}
		if err := r.WebDAV.NormalizeAndValidate(); err != nil {
			return err
		}
	case cloudBackupProviderS3:
		if r.S3 == nil {
			return errors.New(serverText(locale, "cloudBackup.s3Required"))
		}
		if err := r.S3.NormalizeAndValidate(); err != nil {
			return err
		}
	default:
		return errors.New(serverText(locale, "cloudBackup.providerInvalid"))
	}
	return nil
}

func (r *cloudBackupCreateSnapshotRequest) Validate(locale appLocale) error {
	r.Provider = strings.TrimSpace(r.Provider)
	if r.Provider != cloudBackupProviderWebDAV && r.Provider != cloudBackupProviderS3 {
		return errors.New(serverText(locale, "cloudBackup.providerInvalid"))
	}
	return nil
}

func (policy *cloudBackupPolicy) NormalizeAndValidate(locale appLocale) error {
	policy.ScheduleFrequency = strings.TrimSpace(policy.ScheduleFrequency)
	if policy.ScheduleFrequency == "" {
		policy.ScheduleFrequency = "daily"
	}
	policy.ScheduleTime = strings.TrimSpace(policy.ScheduleTime)
	if policy.ScheduleTime == "" {
		policy.ScheduleTime = cloudBackupDefaultScheduleTime
	}
	policy.ScheduleWeekday = strings.TrimSpace(policy.ScheduleWeekday)
	if policy.ScheduleWeekday == "" {
		policy.ScheduleWeekday = cloudBackupDefaultScheduleWeekday
	}
	if policy.Retention == 0 {
		policy.Retention = cloudBackupDefaultRetention
	}
	if policy.Retention < 1 || policy.Retention > cloudBackupMaxRetention {
		return errors.New(serverText(locale, "cloudBackup.retentionInvalid"))
	}
	if policy.ScheduleFrequency != "daily" && policy.ScheduleFrequency != "weekly" {
		return errors.New(serverText(locale, "cloudBackup.scheduleInvalid"))
	}
	if !localTimeRe.MatchString(policy.ScheduleTime) || !isValidLocalTime(policy.ScheduleTime) {
		return errors.New(serverText(locale, "cloudBackup.scheduleInvalid"))
	}
	if !validCloudBackupWeekday(policy.ScheduleWeekday) {
		return errors.New(serverText(locale, "cloudBackup.scheduleInvalid"))
	}
	return nil
}

func (settings *cloudBackupWebDAVSettings) NormalizeAndValidate() error {
	settings.URL = strings.TrimSpace(settings.URL)
	settings.Username = strings.TrimSpace(settings.Username)
	if strings.Contains(strings.TrimSpace(settings.Path), "..") {
		return errors.New("CLOUD_BACKUP_WEBDAV_PATH_INVALID")
	}
	settings.Path = normalizeCloudBackupPrefix(settings.Path, "renewlet")
	parsed, err := url.Parse(settings.URL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return errors.New("CLOUD_BACKUP_WEBDAV_URL_INVALID")
	}
	if parsed.User != nil {
		return errors.New("CLOUD_BACKUP_WEBDAV_URL_INVALID")
	}
	return nil
}

func (settings *cloudBackupS3Settings) NormalizeAndValidate() error {
	settings.Endpoint = strings.TrimSpace(settings.Endpoint)
	settings.Region = strings.TrimSpace(settings.Region)
	settings.Bucket = strings.TrimSpace(settings.Bucket)
	if strings.Contains(strings.TrimSpace(settings.Prefix), "..") {
		return errors.New("CLOUD_BACKUP_S3_PREFIX_INVALID")
	}
	settings.Prefix = normalizeCloudBackupPrefix(settings.Prefix, "renewlet")
	settings.AccessKeyID = strings.TrimSpace(settings.AccessKeyID)
	parsed, err := url.Parse(settings.Endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return errors.New("CLOUD_BACKUP_S3_ENDPOINT_INVALID")
	}
	if parsed.User != nil {
		return errors.New("CLOUD_BACKUP_S3_ENDPOINT_INVALID")
	}
	if settings.Bucket == "" || strings.Contains(settings.Bucket, "/") {
		return errors.New("CLOUD_BACKUP_S3_BUCKET_INVALID")
	}
	if settings.Region == "" {
		return errors.New("CLOUD_BACKUP_S3_REGION_REQUIRED")
	}
	settings.AddressingStyle = ""
	return nil
}

func normalizeCloudBackupPrefix(value string, fallback string) string {
	value = strings.Trim(strings.TrimSpace(value), "/")
	if value == "" {
		return fallback
	}
	parts := []string{}
	for _, part := range strings.Split(value, "/") {
		part = strings.TrimSpace(part)
		if part == "" || part == "." || part == ".." {
			continue
		}
		parts = append(parts, part)
	}
	if len(parts) == 0 {
		return fallback
	}
	return strings.Join(parts, "/")
}

func handleCloudBackupConfigRead(app core.App, e *core.RequestEvent) error {
	config, err := readCloudBackupConfig(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, cloudBackupConfigResponse{Config: config.DTO()})
}

func handleCloudBackupConfigUpdate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[cloudBackupConfigUpdateRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if err := body.Validate(locale); err != nil {
		if strings.TrimSpace(body.Provider) != cloudBackupProviderWebDAV && strings.TrimSpace(body.Provider) != cloudBackupProviderS3 {
			return cloudBackupProviderParameterError(e, locale, "CLOUD_BACKUP_PROVIDER_INVALID", `Use JSON body {"provider":"webdav"} or {"provider":"s3"}.`)
		}
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidPayload", err), err)
	}
	config, err := saveCloudBackupConfig(app, e.Auth.Id, body)
	if err != nil {
		return e.BadRequestError(serverText(locale, "cloudBackup.saveFailed"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, cloudBackupConfigResponse{Config: config.DTO()})
}

func handleCloudBackupTest(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[cloudBackupConfigUpdateRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if err := body.Validate(locale); err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidPayload"), err)
	}
	existing, err := readCloudBackupTarget(app, e.Auth.Id, body.Provider)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	target := targetFromCloudBackupUpdate(e.Auth.Id, body, existing)
	client, err := cloudBackupRemoteClientForTarget(target)
	if err != nil {
		return e.BadRequestError(serverText(locale, "cloudBackup.configIncomplete"), err)
	}
	ctx, cancel := context.WithTimeout(e.Request.Context(), 45*time.Second)
	defer cancel()
	if err := client.Test(ctx); err != nil {
		return cloudBackupOperationError(e, locale, "cloudBackup.testFailed", "CLOUD_BACKUP_TEST_FAILED", err)
	}
	return apiSuccessJSON(e, http.StatusOK, cloudBackupTestResponse{
		CheckedAt: time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func handleCloudBackupsList(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	provider, hasProvider, err := cloudBackupProviderFromRequest(e.Request)
	if err != nil {
		return cloudBackupProviderParameterError(e, locale, "CLOUD_BACKUP_PROVIDER_INVALID", "Use provider=webdav or provider=s3.")
	}
	if !hasProvider {
		return cloudBackupProviderParameterError(e, locale, "CLOUD_BACKUP_PROVIDER_REQUIRED", "Use provider=webdav or provider=s3.")
	}
	target, err := configuredCloudBackupTargetForProvider(app, e.Auth.Id, provider)
	if err != nil {
		return e.BadRequestError(serverText(locale, "cloudBackup.configIncomplete"), err)
	}
	ctx, cancel := context.WithTimeout(e.Request.Context(), 60*time.Second)
	defer cancel()
	manifests, err := target.Client.List(ctx)
	if err != nil {
		return cloudBackupOperationError(e, locale, "cloudBackup.listFailed", "CLOUD_BACKUP_LIST_FAILED", err)
	}
	snapshots := snapshotsFromManifests(target.Provider, manifests)
	sort.Slice(snapshots, func(i, j int) bool {
		return snapshots[i].CreatedAt > snapshots[j].CreatedAt
	})
	return apiSuccessJSON(e, http.StatusOK, cloudBackupSnapshotsResponse{Snapshots: snapshots})
}

func handleCloudBackupsCreate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[cloudBackupCreateSnapshotRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if err := body.Validate(locale); err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidPayload"), err)
	}
	snapshots, err := createCloudBackupSnapshotForUserProvider(e.Request.Context(), app, e.Auth, body.Provider)
	if err != nil {
		markCloudBackupStatus(app, e.Auth.Id, body.Provider, cloudBackupStatusFailed, persistedCloudBackupErrorMessage(err))
		return cloudBackupOperationError(e, locale, "cloudBackup.createFailed", "CLOUD_BACKUP_CREATE_FAILED", err)
	}
	return apiSuccessJSON(e, http.StatusCreated, cloudBackupCreateSnapshotResponse{Snapshots: snapshots})
}

func handleCloudBackupsDownload(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	id := strings.TrimSpace(e.Request.PathValue("id"))
	if id == "" {
		return e.BadRequestError(serverText(locale, "cloudBackup.snapshotInvalid"), nil)
	}
	provider, hasProvider, err := cloudBackupProviderFromRequest(e.Request)
	if err != nil {
		return cloudBackupProviderParameterError(e, locale, "CLOUD_BACKUP_PROVIDER_INVALID", "Use provider=webdav or provider=s3.")
	}
	ctx, cancel := context.WithTimeout(e.Request.Context(), 120*time.Second)
	defer cancel()
	var content []byte
	var manifest cloudBackupSnapshotManifest
	if hasProvider {
		client, err := configuredCloudBackupClientForProvider(app, e.Auth.Id, provider)
		if err != nil {
			return e.BadRequestError(serverText(locale, "cloudBackup.configIncomplete"), err)
		}
		content, manifest, err = client.Download(ctx, id)
		if err != nil {
			return cloudBackupOperationError(e, locale, "cloudBackup.downloadFailed", "CLOUD_BACKUP_DOWNLOAD_FAILED", err)
		}
		if err := verifyCloudBackupSnapshotBytes(content, manifest); err != nil {
			return e.BadRequestError(serverText(locale, "cloudBackup.checksumFailed"), err)
		}
	} else {
		content, manifest, err = downloadCloudBackupSnapshotWithoutProvider(ctx, app, e.Auth.Id, id)
		if err != nil {
			return cloudBackupOperationError(e, locale, "cloudBackup.downloadFailed", "CLOUD_BACKUP_DOWNLOAD_FAILED", err)
		}
	}
	headers := e.Response.Header()
	headers.Set("Content-Type", "application/zip")
	headers.Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, sanitizeDownloadFilename(manifest.Filename)))
	headers.Set("Cache-Control", "no-store")
	headers.Set("X-Content-Type-Options", "nosniff")
	e.Response.WriteHeader(http.StatusOK)
	_, copyErr := e.Response.Write(content)
	return copyErr
}

func handleCloudBackupsDelete(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	id := strings.TrimSpace(e.Request.PathValue("id"))
	if id == "" {
		return e.BadRequestError(serverText(locale, "cloudBackup.snapshotInvalid"), nil)
	}
	provider, hasProvider, err := cloudBackupProviderFromRequest(e.Request)
	if err != nil {
		return cloudBackupProviderParameterError(e, locale, "CLOUD_BACKUP_PROVIDER_INVALID", "Use provider=webdav or provider=s3.")
	}
	ctx, cancel := context.WithTimeout(e.Request.Context(), 60*time.Second)
	defer cancel()
	if hasProvider {
		client, err := configuredCloudBackupClientForProvider(app, e.Auth.Id, provider)
		if err != nil {
			return e.BadRequestError(serverText(locale, "cloudBackup.configIncomplete"), err)
		}
		if err := client.Delete(ctx, id); err != nil {
			return cloudBackupOperationError(e, locale, "cloudBackup.deleteFailed", "CLOUD_BACKUP_DELETE_FAILED", err)
		}
	} else if err := deleteCloudBackupSnapshotWithoutProvider(ctx, app, e.Auth.Id, id); err != nil {
		messageKey := "cloudBackup.deleteFailed"
		if remoteErr := cloudBackupRemoteErrorFrom(err); remoteErr != nil && remoteErr.code == "CLOUD_BACKUP_PROVIDER_REQUIRED" {
			messageKey = "cloudBackup.providerRequired"
		}
		return cloudBackupOperationError(e, locale, messageKey, "CLOUD_BACKUP_DELETE_FAILED", err)
	}
	return apiEmptySuccessJSON(e, http.StatusOK)
}

func configuredCloudBackupTargets(app core.App, userID string) (cloudBackupResolvedConfig, []cloudBackupTarget, error) {
	config, err := readCloudBackupConfig(app, userID)
	if err != nil {
		return config, nil, err
	}
	targets := cloudBackupTargetsForConfig(config)
	if len(targets) == 0 {
		return config, nil, errors.New("CLOUD_BACKUP_TARGET_REQUIRED")
	}
	return config, targets, nil
}

func configuredCloudBackupClientForProvider(app core.App, userID string, provider string) (cloudBackupRemoteClient, error) {
	target, err := configuredCloudBackupTargetForProvider(app, userID, provider)
	if err != nil {
		return nil, err
	}
	return target.Client, nil
}

func configuredCloudBackupTargetForProvider(app core.App, userID string, provider string) (cloudBackupTarget, error) {
	config, err := readCloudBackupConfig(app, userID)
	if err != nil {
		return cloudBackupTarget{}, err
	}
	// 列表、立即备份、恢复和删除都在这里收敛到单 provider，避免另一目标的配置或上游错误串进当前请求。
	return cloudBackupRemoteTargetForProvider(config, provider)
}

func cloudBackupRemoteClientForTarget(target cloudBackupResolvedTarget) (cloudBackupRemoteClient, error) {
	switch target.Provider {
	case cloudBackupProviderWebDAV:
		if target.WebDAV == nil {
			return nil, errors.New("CLOUD_BACKUP_WEBDAV_REQUIRED")
		}
		if strings.TrimSpace(target.Credential.WebDAVPassword) == "" {
			return nil, errors.New("CLOUD_BACKUP_WEBDAV_CREDENTIAL_REQUIRED")
		}
		return newWebDAVCloudBackupClient(*target.WebDAV, target.Credential.WebDAVPassword), nil
	case cloudBackupProviderS3:
		if target.S3 == nil {
			return nil, errors.New("CLOUD_BACKUP_S3_REQUIRED")
		}
		if strings.TrimSpace(target.S3.AccessKeyID) == "" || strings.TrimSpace(target.Credential.S3SecretAccessKey) == "" {
			return nil, errors.New("CLOUD_BACKUP_S3_CREDENTIAL_REQUIRED")
		}
		return newS3CloudBackupClient(*target.S3, target.Credential.S3SecretAccessKey), nil
	default:
		return nil, errors.New("CLOUD_BACKUP_PROVIDER_INVALID")
	}
}

func cloudBackupTargetsForConfig(config cloudBackupResolvedConfig) []cloudBackupTarget {
	targets := []cloudBackupTarget{}
	for _, provider := range cloudBackupTargetProvidersForConfig(config) {
		if target, err := cloudBackupRemoteTargetForProvider(config, provider); err == nil {
			targets = append(targets, target)
		}
	}
	return targets
}

func cloudBackupRemoteTargetForProvider(config cloudBackupResolvedConfig, provider string) (cloudBackupTarget, error) {
	target, ok := config.Targets[provider]
	if !ok {
		return cloudBackupTarget{}, errors.New("CLOUD_BACKUP_TARGET_REQUIRED")
	}
	client, err := cloudBackupRemoteClientForTarget(target)
	if err != nil {
		return cloudBackupTarget{}, err
	}
	return cloudBackupTarget{Provider: provider, Client: client, Retention: target.Policy.Retention}, nil
}

func cloudBackupTargetProvidersForConfig(config cloudBackupResolvedConfig) []string {
	providers := []string{}
	if config.Provider == cloudBackupProviderWebDAV || config.Provider == cloudBackupProviderS3 {
		providers = append(providers, config.Provider)
	}
	for _, provider := range []string{cloudBackupProviderWebDAV, cloudBackupProviderS3} {
		if provider != config.Provider {
			providers = append(providers, provider)
		}
	}
	return providers
}

func createCloudBackupSnapshotForUserProvider(ctx context.Context, app core.App, user *core.Record, provider string) ([]cloudBackupSnapshotDTO, error) {
	config, err := readCloudBackupConfig(app, user.Id)
	if err != nil {
		return nil, err
	}
	target, err := cloudBackupRemoteTargetForProvider(config, provider)
	if err != nil {
		return nil, err
	}
	return createCloudBackupSnapshotForTargets(ctx, app, user, []cloudBackupTarget{target})
}

func createCloudBackupSnapshotForTargets(ctx context.Context, app core.App, user *core.Record, targets []cloudBackupTarget) ([]cloudBackupSnapshotDTO, error) {
	if len(targets) == 0 {
		return nil, errors.New("CLOUD_BACKUP_TARGET_REQUIRED")
	}
	// 多目标只在定时任务内部复用同一份 ZIP；手动立即备份会传入单个当前 provider 目标。
	payload, err := buildCloudBackupSnapshotPayload(app, user)
	if err != nil {
		return nil, err
	}
	snapshots := make([]cloudBackupSnapshotDTO, 0, len(targets))
	err = withCloudBackupSnapshotPayload(user.Id, payload, func(payload cloudBackupSnapshotPayload) error {
		for _, target := range targets {
			snapshot, err := uploadCloudBackupSnapshotToTarget(ctx, app, user.Id, payload, target)
			if err != nil {
				return err
			}
			snapshots = append(snapshots, snapshot)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return snapshots, nil
}

func withCloudBackupSnapshotPayload(userID string, payload cloudBackupSnapshotPayload, use func(cloudBackupSnapshotPayload) error) error {
	// 临时 ZIP 只在一个用户的一轮上传中存活，避免 cron 扫描多个用户时把快照累积到整轮结束。
	defer func() {
		if cleanupErr := payload.Source.Cleanup(); cleanupErr != nil {
			slog.Warn("cloud backup temporary snapshot cleanup failed", "user", userID, "error", cleanupErr)
		}
	}()
	return use(payload)
}

func buildCloudBackupSnapshotPayload(app core.App, user *core.Record) (cloudBackupSnapshotPayload, error) {
	source, exportedAt, err := buildCloudBackupExportZip(app, user)
	if err != nil {
		return cloudBackupSnapshotPayload{}, err
	}
	reader, err := source.Open()
	if err != nil {
		_ = source.Cleanup()
		return cloudBackupSnapshotPayload{}, err
	}
	hash := sha256.New()
	_, copyErr := io.Copy(hash, reader)
	closeErr := reader.Close()
	if copyErr != nil || closeErr != nil {
		_ = source.Cleanup()
		if copyErr != nil {
			return cloudBackupSnapshotPayload{}, copyErr
		}
		return cloudBackupSnapshotPayload{}, closeErr
	}
	id := cloudBackupSnapshotID(exportedAt)
	filename := id + ".zip"
	manifest := cloudBackupSnapshotManifest{
		Kind:                "renewlet-cloud-backup-snapshot",
			SchemaVersion:       cloudBackupTransportSchemaVersion,
		ID:                  id,
		Filename:            filename,
		CreatedAt:           exportedAt.Format(time.RFC3339Nano),
		SizeBytes:           source.Size(),
		SHA256:              hex.EncodeToString(hash.Sum(nil)),
		ExportKind:          "renewlet-export",
			ExportSchemaVersion: renewletExportSchemaVersion,
	}
	return cloudBackupSnapshotPayload{Source: source, ID: id, Filename: filename, Manifest: manifest}, nil
}

func uploadCloudBackupSnapshotToTarget(ctx context.Context, app core.App, userID string, payload cloudBackupSnapshotPayload, target cloudBackupTarget) (cloudBackupSnapshotDTO, error) {
	// 远端只信任 sidecar manifest + 本地重算 sha256；恢复下载前后都会再次校验，避免坏快照进入导入预览。
	if err := target.Client.Upload(ctx, payload.Filename, payload.Source, payload.Manifest); err != nil {
		return cloudBackupSnapshotDTO{}, err
	}
	if err := enforceCloudBackupRetention(ctx, target.Client, target.Retention, payload.ID); err != nil {
		slog.Warn("cloud backup retention cleanup failed", "user", userID, "provider", target.Provider, "error", err)
	}
	markCloudBackupSuccess(app, userID, target.Provider, payload.Manifest.CreatedAt)
	return snapshotFromManifest(target.Provider, payload.Manifest), nil
}

func verifyCloudBackupSnapshotBytes(content []byte, manifest cloudBackupSnapshotManifest) error {
	if int64(len(content)) > cloudBackupSnapshotMaxBytes {
		return errors.New("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE")
	}
	if manifest.Kind != "renewlet-cloud-backup-snapshot" ||
		manifest.SchemaVersion != cloudBackupTransportSchemaVersion ||
		manifest.ExportKind != "renewlet-export" ||
		manifest.ExportSchemaVersion != renewletExportSchemaVersion {
		return errors.New("CLOUD_BACKUP_MANIFEST_INVALID")
	}
	if manifest.SizeBytes != int64(len(content)) {
		return errors.New("CLOUD_BACKUP_SIZE_MISMATCH")
	}
	hash := sha256.Sum256(content)
	if !strings.EqualFold(hex.EncodeToString(hash[:]), manifest.SHA256) {
		return errors.New("CLOUD_BACKUP_SHA256_MISMATCH")
	}
	return nil
}

func enforceCloudBackupRetention(ctx context.Context, client cloudBackupRemoteClient, retention int, keepID string) error {
	if retention <= 0 {
		retention = cloudBackupDefaultRetention
	}
	manifests, err := client.List(ctx)
	if err != nil {
		return err
	}
	sort.Slice(manifests, func(i, j int) bool {
		return manifests[i].CreatedAt > manifests[j].CreatedAt
	})
	for index, manifest := range manifests {
		if index < retention || manifest.ID == keepID {
			continue
		}
		if err := client.Delete(ctx, manifest.ID); err != nil {
			return err
		}
	}
	return nil
}

func snapshotsFromManifests(provider string, manifests []cloudBackupSnapshotManifest) []cloudBackupSnapshotDTO {
	snapshots := make([]cloudBackupSnapshotDTO, 0, len(manifests))
	for _, manifest := range manifests {
		snapshots = append(snapshots, snapshotFromManifest(provider, manifest))
	}
	sort.Slice(snapshots, func(i, j int) bool {
		return snapshots[i].CreatedAt > snapshots[j].CreatedAt
	})
	return snapshots
}

func snapshotFromManifest(provider string, manifest cloudBackupSnapshotManifest) cloudBackupSnapshotDTO {
	return cloudBackupSnapshotDTO{
		ID:        manifest.ID,
		Filename:  manifest.Filename,
		Provider:  provider,
		CreatedAt: manifest.CreatedAt,
		SizeBytes: manifest.SizeBytes,
		SHA256:    manifest.SHA256,
	}
}

func cloudBackupSnapshotID(exportedAt time.Time) string {
	return "renewlet-export-v1-" + exportedAt.Format("20060102T150405Z") + "-" + randomHex(4)
}

func randomHex(bytesLen int) string {
	data := make([]byte, bytesLen)
	if _, err := rand.Read(data); err != nil {
		return fmt.Sprintf("%08x", time.Now().UnixNano())
	}
	return hex.EncodeToString(data)
}

func sanitizeDownloadFilename(filename string) string {
	filename = path.Base(strings.TrimSpace(filename))
	if filename == "." || filename == "/" || filename == "" {
		return "renewlet-export-v1.zip"
	}
	return strings.ReplaceAll(filename, `"`, "")
}

func cloudBackupProviderFromRequest(request *http.Request) (string, bool, error) {
	values, ok := request.URL.Query()["provider"]
	if !ok || len(values) == 0 {
		return "", false, nil
	}
	provider := strings.TrimSpace(values[0])
	if provider != cloudBackupProviderWebDAV && provider != cloudBackupProviderS3 {
		return "", true, errors.New("CLOUD_BACKUP_PROVIDER_INVALID")
	}
	return provider, true, nil
}

func cloudBackupProviderParameterError(e *core.RequestEvent, locale appLocale, code string, message string) error {
	return apiErrorJSON(e, http.StatusBadRequest, code, serverText(locale, "cloudBackup.providerInvalid"), &cloudBackupErrorDetails{
		RawResponseText: optionalCloudBackupString(message),
	})
}

func cloudBackupOperationError(e *core.RequestEvent, locale appLocale, messageKey string, fallbackCode string, err error) error {
	if remoteErr := cloudBackupRemoteErrorFrom(err); remoteErr != nil {
		// 操作层 code 保持稳定，provider 细节只放 details；数据库状态只保存 persistedCloudBackupErrorMessage 的短摘要。
		return apiErrorJSON(e, http.StatusBadRequest, fallbackCode, serverText(locale, messageKey), remoteErr.details)
	}
	return apiErrorJSON(e, http.StatusBadRequest, fallbackCode, serverText(locale, messageKey), cloudBackupLocalErrorDetails(err))
}

func persistedCloudBackupErrorMessage(err error) string {
	if remoteErr := cloudBackupRemoteErrorFrom(err); remoteErr != nil {
		return remoteErr.code
	}
	return "local_sdk_error"
}

func markCloudBackupSuccess(app core.App, userID string, provider string, backupAt string) {
	if record, err := app.FindFirstRecordByFilter("cloud_backup_targets", "user = {:user} && provider = {:provider}", dbx.Params{"user": userID, "provider": provider}); err == nil && record != nil {
		record.Set("lastBackupAt", backupAt)
		record.Set("lastStatus", cloudBackupStatusSuccess)
		record.Set("lastError", "")
		record.Set("lockedUntil", "")
		if err := app.Save(record); err != nil {
			slog.Warn("cloud backup success state update failed", "user", userID, "provider", provider, "error", err)
		}
	}
}

func markCloudBackupStatus(app core.App, userID string, provider string, status string, message string) {
	if record, err := app.FindFirstRecordByFilter("cloud_backup_targets", "user = {:user} && provider = {:provider}", dbx.Params{"user": userID, "provider": provider}); err == nil && record != nil {
		record.Set("lastStatus", status)
		record.Set("lastError", strings.TrimSpace(message))
		record.Set("lockedUntil", "")
		if err := app.Save(record); err != nil {
			slog.Warn("cloud backup status update failed", "user", userID, "provider", provider, "error", err)
		}
	}
}
