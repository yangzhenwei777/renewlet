package main

// 版本测试聚焦 Release feed、stable/RC 选择、上游错误回显和 Docker 能力矩阵，不执行真实下载或替换。

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// 上游 raw body 只能随当前管理员强制检查回显一次，缓存响应不得保留第三方响应明文。
func TestSystemVersionFailureIncludesOneShotUpstreamDetailsWithoutCachingRawBody(t *testing.T) {
	oldVersion, oldBuildType := Version, BuildType
	Version, BuildType = "0.1.0", "release"
	t.Cleanup(func() {
		Version, BuildType = oldVersion, oldBuildType
	})

	service := newSystemUpdateService(&fakeSystemReleaseClient{release: &systemRelease{
		TagName:     "v0.1.0",
		Name:        "Renewlet 0.1.0",
		PublishedAt: "2026-06-04T00:00:00Z",
		HTMLURL:     "https://github.com/zhiyingzzhou/renewlet/releases/tag/v0.1.0",
		Assets:      []systemReleaseAsset{},
	}})
	service.now = func() time.Time { return time.Unix(1_779_820_800, 0) }
	if _, err := service.CheckVersion(context.Background(), localeZhCN, true); err != nil {
		t.Fatal(err)
	}

	service.client = &httpSystemReleaseClient{
		metadataClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusForbidden,
				Status:     "403 Forbidden",
				Header:     http.Header{"Content-Type": []string{"text/plain"}},
				Body:       io.NopCloser(strings.NewReader("release feed unavailable")),
				Request:    request,
			}, nil
		})},
	}

	failed, err := service.CheckVersion(context.Background(), localeZhCN, true)
	if err != nil {
		t.Fatal(err)
	}
	if failed.ErrorDetails == nil || failed.ErrorDetails.RawResponseText == nil {
		t.Fatalf("expected one-shot upstream details, got %#v", failed.ErrorDetails)
	}
	if *failed.ErrorDetails.RawResponseText != "release feed unavailable" {
		t.Fatalf("expected redacted upstream body, got %#v", failed.ErrorDetails.RawResponseText)
	}
	if payload, _ := json.Marshal(failed.ErrorDetails); strings.Contains(string(payload), "Authorization") {
		t.Fatalf("upstream details leaked request metadata: %s", payload)
	}

	cached, err := service.CheckVersion(context.Background(), localeZhCN, false)
	if err != nil {
		t.Fatal(err)
	}
	if cached.ErrorDetails != nil {
		t.Fatalf("cached version response must not keep raw upstream details: %#v", cached.ErrorDetails)
	}
}

func TestSelfUpdateCapabilityMatrix(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("self-update capability matrix depends on linux Docker binary semantics")
	}

	oldVersion, oldBuildType := Version, BuildType
	t.Cleanup(func() {
		Version, BuildType = oldVersion, oldBuildType
	})

	cases := []struct {
		name           string
		buildType      string
		enabled        string
		writeBinary    bool
		wantDeployment string
		wantMode       string
		wantSupported  bool
		wantReasonPart string
	}{
		{
			name:           "docker release supports in-app binary update",
			buildType:      "release",
			enabled:        "true",
			writeBinary:    true,
			wantDeployment: "docker",
			wantMode:       "in-app-binary",
			wantSupported:  true,
		},
		{
			name:           "docker release with self update disabled falls back to compose",
			buildType:      "release",
			enabled:        "false",
			writeBinary:    true,
			wantDeployment: "docker",
			wantMode:       "docker-compose",
			wantSupported:  false,
			wantReasonPart: "RENEWLET_SELF_UPDATE_ENABLED=false",
		},
		{
			name:           "old docker bridge cannot replace container binary",
			buildType:      "release",
			enabled:        "true",
			writeBinary:    false,
			wantDeployment: "docker",
			wantMode:       "docker-compose",
			wantSupported:  false,
			wantReasonPart: "docker compose pull",
		},
		{
			name:           "non release source build stays manual",
			buildType:      "source",
			enabled:        "true",
			writeBinary:    true,
			wantDeployment: "source",
			wantMode:       "source-manual",
			wantSupported:  false,
			wantReasonPart: "Release",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tempDir := t.TempDir()
			binaryPath := filepath.Join(tempDir, "renewlet")
			if tc.writeBinary {
				if err := os.WriteFile(binaryPath, []byte("old"), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("RENEWLET_SELF_UPDATE_ENABLED", tc.enabled)
			t.Setenv("RENEWLET_SELF_UPDATE_BINARY", binaryPath)
			t.Setenv("RENEWLET_SELF_UPDATE_BACKUP_DIR", filepath.Join(tempDir, "backups"))
			Version, BuildType = "1.0.0", tc.buildType

			got := selfUpdateCapability(localeZhCN)
			if got.deployment != tc.wantDeployment {
				t.Fatalf("deployment = %q, want %q", got.deployment, tc.wantDeployment)
			}
			if got.updateMode != tc.wantMode {
				t.Fatalf("updateMode = %q, want %q", got.updateMode, tc.wantMode)
			}
			if got.supported != tc.wantSupported {
				t.Fatalf("supported = %v, want %v", got.supported, tc.wantSupported)
			}
			if tc.wantReasonPart != "" && !strings.Contains(got.unsupportedReason, tc.wantReasonPart) {
				t.Fatalf("unsupportedReason = %q, want to contain %q", got.unsupportedReason, tc.wantReasonPart)
			}
		})
	}
}

func TestStableVersionSkipsRCEntriesFromFeed(t *testing.T) {
	oldVersion, oldBuildType := Version, BuildType
	Version, BuildType = "0.1.0", "release"
	t.Cleanup(func() {
		Version, BuildType = oldVersion, oldBuildType
	})

	client := &fakeSystemReleaseClient{release: &systemRelease{
		TagName: "v0.2.0-rc.1",
	}}
	service := newSystemUpdateService(client)

	response, err := service.CheckVersion(context.Background(), localeZhCN, true)
	if err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&client.fetchCount); got != 1 {
		t.Fatalf("FetchReleases calls = %d, want 1", got)
	}
	if !response.CheckSucceeded || response.HasUpdate {
		t.Fatalf("stable version should not accept prerelease target: %#v", response)
	}
}

func TestStableVersionSelectsLatestStableReleaseFromFeed(t *testing.T) {
	oldVersion, oldBuildType := Version, BuildType
	Version, BuildType = "0.1.0", "release"
	t.Cleanup(func() {
		Version, BuildType = oldVersion, oldBuildType
	})

	client := &fakeSystemReleaseClient{releases: []systemRelease{
		releaseFixture("v0.2.0-rc.1"),
		releaseFixture("v0.1.1"),
	}}
	service := newSystemUpdateService(client)

	response, err := service.CheckVersion(context.Background(), localeZhCN, true)
	if err != nil {
		t.Fatal(err)
	}
	if !response.CheckSucceeded || !response.HasUpdate {
		t.Fatalf("expected stable update from feed, got %#v", response)
	}
	if response.LatestVersion != "0.1.1" {
		t.Fatalf("latestVersion = %q, want 0.1.1", response.LatestVersion)
	}
}

func TestRCVersionSelectsHighestNewerRC(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("self-update capability depends on linux Docker binary semantics")
	}
	tempDir := t.TempDir()
	binaryPath := filepath.Join(tempDir, "renewlet")
	if err := os.WriteFile(binaryPath, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RENEWLET_SELF_UPDATE_ENABLED", "true")
	t.Setenv("RENEWLET_SELF_UPDATE_BINARY", binaryPath)
	t.Setenv("RENEWLET_SELF_UPDATE_BACKUP_DIR", filepath.Join(tempDir, "backups"))
	oldVersion, oldBuildType := Version, BuildType
	Version, BuildType = "0.1.0-rc.1", "release"
	t.Cleanup(func() {
		Version, BuildType = oldVersion, oldBuildType
	})

	client := &fakeSystemReleaseClient{releases: []systemRelease{
		releaseFixture("v0.1.0"),
		releaseFixture("v0.1.0-rc.2"),
		releaseFixture("v0.2.0-rc.1"),
		releaseFixture("v0.2.0-beta.1"),
		releaseFixture("v0.1.0-rc.1"),
	}}
	service := newSystemUpdateService(client)

	response, err := service.CheckVersion(context.Background(), localeZhCN, true)
	if err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&client.fetchCount); got != 1 {
		t.Fatalf("FetchReleases should be used for rc versions")
	}
	if !response.CheckSucceeded || !response.HasUpdate {
		t.Fatalf("expected rc version update, got %#v", response)
	}
	if !response.UpdateSupported {
		t.Fatalf("expected rc version update to be installable, got %#v", response)
	}
	if response.LatestVersion != "0.2.0-rc.1" {
		t.Fatalf("latestVersion = %q, want 0.2.0-rc.1", response.LatestVersion)
	}
}

func TestSystemVersionReleaseAssetsStayArrayWhenEmpty(t *testing.T) {
	oldVersion, oldBuildType := Version, BuildType
	Version, BuildType = "0.1.0-rc.1", "release"
	t.Cleanup(func() {
		Version, BuildType = oldVersion, oldBuildType
	})
	t.Setenv("RENEWLET_SELF_UPDATE_ENABLED", "false")

	service := newSystemUpdateService(&fakeSystemReleaseClient{releases: []systemRelease{
		{
			TagName:     "v0.1.0-rc.2",
			Name:        "Renewlet 0.1.0-rc.2",
			PublishedAt: "2026-06-04T00:00:00Z",
			HTMLURL:     "https://github.com/zhiyingzzhou/renewlet/releases/tag/v0.1.0-rc.2",
			Assets:      nil,
		},
	}})

	first, err := service.CheckVersion(context.Background(), localeZhCN, true)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.CheckVersion(context.Background(), localeZhCN, false)
	if err != nil {
		t.Fatal(err)
	}
	for name, response := range map[string]*systemVersionResponse{"force": first, "cached": second} {
		payload, err := json.Marshal(response)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(payload), `"assets":[]`) {
			t.Fatalf("%s response JSON = %s, want releaseInfo.assets as []", name, payload)
		}
		if strings.Contains(string(payload), `"assets":null`) {
			t.Fatalf("%s response JSON = %s, must not encode assets as null", name, payload)
		}
	}
	if !second.Cached {
		t.Fatal("second check should come from cache")
	}
}

func TestSystemVersionDisablesInAppUpdateWhenReleaseAssetsMissing(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("self-update capability depends on linux Docker binary semantics")
	}
	oldVersion, oldBuildType := Version, BuildType
	t.Cleanup(func() {
		Version, BuildType = oldVersion, oldBuildType
	})

	cases := []struct {
		name           string
		assets         []systemReleaseAsset
		wantReasonPart string
	}{
		{
			name:           "missing platform archive",
			assets:         []systemReleaseAsset{{Name: "renewlet-docker-v0.1.0-rc.2.zip"}},
			wantReasonPart: systemArchiveName("0.1.0-rc.2"),
		},
		{
			name:           "missing checksums",
			assets:         []systemReleaseAsset{{Name: systemArchiveName("0.1.0-rc.2")}},
			wantReasonPart: "checksums.txt",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tempDir := t.TempDir()
			binaryPath := filepath.Join(tempDir, "renewlet")
			if err := os.WriteFile(binaryPath, []byte("old"), 0o755); err != nil {
				t.Fatal(err)
			}
			t.Setenv("RENEWLET_SELF_UPDATE_ENABLED", "true")
			t.Setenv("RENEWLET_SELF_UPDATE_BINARY", binaryPath)
			t.Setenv("RENEWLET_SELF_UPDATE_BACKUP_DIR", filepath.Join(tempDir, "backups"))
			Version, BuildType = "0.1.0-rc.1", "release"

			service := newSystemUpdateService(&fakeSystemReleaseClient{releases: []systemRelease{
				{
					TagName: "v0.1.0-rc.2",
					Name:    "Renewlet 0.1.0-rc.2",
					HTMLURL: "https://github.com/zhiyingzzhou/renewlet/releases/tag/v0.1.0-rc.2",
					Assets:  tc.assets,
				},
			}})

			response, err := service.CheckVersion(context.Background(), localeZhCN, true)
			if err != nil {
				t.Fatal(err)
			}
			if !response.CheckSucceeded || !response.HasUpdate {
				t.Fatalf("expected newer release to be reported, got %#v", response)
			}
			if response.UpdateSupported {
				t.Fatalf("UpdateSupported = true, want false when install asset is missing: %#v", response)
			}
			if !strings.Contains(response.UnsupportedReason, tc.wantReasonPart) {
				t.Fatalf("UnsupportedReason = %q, want to contain %q", response.UnsupportedReason, tc.wantReasonPart)
			}
			if response.ReleaseInfo == nil || response.ReleaseInfo.HTMLURL == "" {
				t.Fatalf("release info should stay available: %#v", response.ReleaseInfo)
			}
		})
	}
}

func TestStableCurrentVersionDoesNotUpdateToRC(t *testing.T) {
	oldVersion, oldBuildType := Version, BuildType
	Version, BuildType = "0.1.0", "release"
	t.Cleanup(func() {
		Version, BuildType = oldVersion, oldBuildType
	})

	release := releaseFixture("v0.2.0-rc.1")
	service := newSystemUpdateService(&fakeSystemReleaseClient{release: &release})

	response, err := service.CheckVersion(context.Background(), localeZhCN, true)
	if err != nil {
		t.Fatal(err)
	}
	if !response.CheckSucceeded || response.HasUpdate {
		t.Fatalf("stable current version must not update to rc: %#v", response)
	}
}

func TestRCVersionReportsLatestWhenNoNewerCandidateExists(t *testing.T) {
	oldVersion, oldBuildType := Version, BuildType
	Version, BuildType = "0.1.0-rc.1", "release"
	t.Cleanup(func() {
		Version, BuildType = oldVersion, oldBuildType
	})

	service := newSystemUpdateService(&fakeSystemReleaseClient{releases: []systemRelease{
		releaseFixture("v0.1.0"),
		releaseFixture("v0.1.0-rc.1"),
		releaseFixture("v0.2.0-beta.1"),
	}})

	response, err := service.CheckVersion(context.Background(), localeZhCN, true)
	if err != nil {
		t.Fatal(err)
	}
	if !response.CheckSucceeded || response.HasUpdate {
		t.Fatalf("expected successful rc check without update, got %#v", response)
	}
	if response.Warning != "" {
		t.Fatalf("warning = %q, want empty", response.Warning)
	}
	if response.LatestVersion != "0.1.0-rc.1" {
		t.Fatalf("latestVersion = %q, want current version", response.LatestVersion)
	}
}
