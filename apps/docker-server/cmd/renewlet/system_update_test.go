package main

// 系统更新测试保护 Docker 页面内自更新的 Release 选择、checksum、备份恢复和 pending restart 状态机。
// fake client 隔离 GitHub 网络，重点锁住 /renewlet 稳定入口与 current 二进制替换契约。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSystemVersionComparison(t *testing.T) {
	cases := []struct {
		name    string
		current string
		latest  string
		want    bool
	}{
		{name: "patch update", current: "0.1.0", latest: "0.1.1", want: true},
		{name: "minor update", current: "0.1.9", latest: "0.2.0", want: true},
		{name: "hotfix patch update", current: "0.2.9", latest: "0.2.91", want: true},
		{name: "hotfix patch increment", current: "0.2.91", latest: "0.2.92", want: true},
		{name: "minor hotfix patch update", current: "0.3.2", latest: "0.3.21", want: true},
		{name: "equal stable", current: "0.1.0", latest: "0.1.0", want: false},
		{name: "ignore latest prerelease", current: "0.1.0", latest: "0.2.0-rc.1", want: false},
		{name: "stable channel ignores current prerelease", current: "0.2.0-rc.1", latest: "0.2.0", want: false},
		{name: "invalid current is not updateable", current: "dev", latest: "0.2.0", want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isNewerSystemVersion(tc.current, tc.latest); got != tc.want {
				t.Fatalf("isNewerSystemVersion(%q, %q) = %v, want %v", tc.current, tc.latest, got, tc.want)
			}
		})
	}
}

func TestSystemRCVersionComparison(t *testing.T) {
	cases := []struct {
		name    string
		current string
		latest  string
		want    bool
	}{
		{name: "same base rc increment", current: "0.1.0-rc.1", latest: "0.1.0-rc.2", want: true},
		{name: "cross base rc increment", current: "0.1.0-rc.1", latest: "0.2.0-rc.1", want: true},
		{name: "older rc rejected", current: "0.1.0-rc.2", latest: "0.1.0-rc.1", want: false},
		{name: "stable target rejected", current: "0.1.0-rc.1", latest: "0.1.0", want: false},
		{name: "stable current rejected", current: "0.1.0", latest: "0.2.0-rc.1", want: false},
		{name: "invalid rc suffix rejected", current: "0.1.0-rc.1", latest: "0.2.0-beta.1", want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isNewerSystemRCVersion(tc.current, tc.latest); got != tc.want {
				t.Fatalf("isNewerSystemRCVersion(%q, %q) = %v, want %v", tc.current, tc.latest, got, tc.want)
			}
		})
	}
}

func TestSelectSystemUpdateAssets(t *testing.T) {
	archiveName := systemArchiveName("1.2.3")
	archive, checksum, err := selectSystemUpdateAssets([]systemReleaseAsset{
		{Name: archiveName, BrowserDownloadURL: "https://github.com/zhiyingzzhou/renewlet/releases/download/v1.2.3/" + archiveName},
		{Name: "checksums.txt", BrowserDownloadURL: "https://github.com/zhiyingzzhou/renewlet/releases/download/v1.2.3/checksums.txt"},
	}, "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if archive.Name != archiveName || checksum.Name != "checksums.txt" {
		t.Fatalf("unexpected assets: %#v %#v", archive, checksum)
	}
}

func TestSystemReleaseAssetProbeUsesDeterministicReleaseURLs(t *testing.T) {
	archiveName := systemArchiveName("1.2.3")
	seen := map[string]*http.Request{}
	var seenMu sync.Mutex
	client := &httpSystemReleaseClient{
		assetClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			seenMu.Lock()
			seen[request.URL.Path] = request
			seenMu.Unlock()
			if request.Method != http.MethodHead {
				t.Fatalf("method = %s, want HEAD", request.Method)
			}
			if got := request.Header.Get("Authorization"); got != "" {
				t.Fatalf("Authorization = %q", got)
			}
			status := http.StatusOK
			size := int64(123)
			if strings.HasSuffix(request.URL.Path, "/checksums.txt") {
				size = 45
			}
			return &http.Response{
				StatusCode:    status,
				Status:        "200 OK",
				Header:        make(http.Header),
				ContentLength: size,
				Body:          io.NopCloser(strings.NewReader("")),
				Request:       request,
			}, nil
		})},
	}

	assets := client.ProbeReleaseAssets(context.Background(), "v1.2.3", "1.2.3")
	if len(assets) != 2 {
		t.Fatalf("assets = %#v, want 2 assets", assets)
	}
	if assets[0].Name != archiveName || assets[0].Size != 123 {
		t.Fatalf("archive asset = %#v", assets[0])
	}
	if assets[1].Name != "checksums.txt" || assets[1].Size != 45 {
		t.Fatalf("checksum asset = %#v", assets[1])
	}
	seenMu.Lock()
	defer seenMu.Unlock()
	if seen["/zhiyingzzhou/renewlet/releases/download/v1.2.3/"+archiveName] == nil || seen["/zhiyingzzhou/renewlet/releases/download/v1.2.3/checksums.txt"] == nil {
		t.Fatalf("unexpected probed paths: %#v", seen)
	}
}

func TestSystemReleaseAssetProbeRunsBothDeterministicHeadsConcurrently(t *testing.T) {
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	client := &httpSystemReleaseClient{
		assetClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			started <- struct{}{}
			<-release
			return &http.Response{
				StatusCode: http.StatusOK,
				Status:     "200 OK",
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("")),
				Request:    request,
			}, nil
		})},
	}
	done := make(chan []systemReleaseAsset, 1)
	go func() {
		done <- client.ProbeReleaseAssets(context.Background(), "v1.2.3", "1.2.3")
	}()
	for count := 0; count < 2; count++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("asset HEAD requests did not run concurrently")
		}
	}
	close(release)
	assets := <-done
	if len(assets) != 2 || assets[0].Name != systemArchiveName("1.2.3") || assets[1].Name != "checksums.txt" {
		t.Fatalf("concurrent probe changed deterministic result order: %#v", assets)
	}
}

func TestSystemReleaseDownloadComputesChecksumWhileWriting(t *testing.T) {
	content := []byte("release archive")
	client := &httpSystemReleaseClient{
		downloader: newSystemReleaseDownloader(&http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode:    http.StatusOK,
				Status:        "200 OK",
				Header:        make(http.Header),
				ContentLength: int64(len(content)),
				Body:          io.NopCloser(strings.NewReader(string(content))),
				Request:       request,
			}, nil
		})}),
	}
	targetPath := filepath.Join(t.TempDir(), "archive.tar.gz")
	actual, err := client.DownloadFile(context.Background(), "https://github.com/zhiyingzzhou/renewlet/releases/download/v1.2.3/archive.tar.gz", targetPath, int64(len(content)), int64(len(content)))
	if err != nil {
		t.Fatal(err)
	}
	expected := sha256.Sum256(content)
	if actual != hex.EncodeToString(expected[:]) {
		t.Fatalf("download checksum = %q, want %q", actual, hex.EncodeToString(expected[:]))
	}
	written, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(written) != string(content) {
		t.Fatalf("downloaded content = %q", written)
	}
	oversizedPath := filepath.Join(t.TempDir(), "oversized.tar.gz")
	if _, err := client.DownloadFile(context.Background(), "https://github.com/zhiyingzzhou/renewlet/releases/download/v1.2.3/oversized.tar.gz", oversizedPath, int64(len(content)), int64(len(content)-1)); err == nil {
		t.Fatal("expected archive size limit to reject the download")
	}
}

func TestSystemReleaseAssetProbeOmitsMissingAssets(t *testing.T) {
	client := &httpSystemReleaseClient{
		assetClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			status := http.StatusOK
			if strings.HasSuffix(request.URL.Path, "/checksums.txt") {
				status = http.StatusNotFound
			}
			return &http.Response{
				StatusCode: status,
				Status:     fmt.Sprintf("%d", status),
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("")),
				Request:    request,
			}, nil
		})},
	}

	assets := client.ProbeReleaseAssets(context.Background(), "v1.2.3", "1.2.3")
	if len(assets) != 1 || assets[0].Name != systemArchiveName("1.2.3") {
		t.Fatalf("assets = %#v, want only archive asset", assets)
	}
}

func TestGitHubReleaseFeedRequestUsesAtomWithoutAuthorization(t *testing.T) {
	var captured *http.Request
	client := &httpSystemReleaseClient{
		metadataClient: &http.Client{
			Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				captured = request
				return &http.Response{
					StatusCode: http.StatusOK,
					Status:     "200 OK",
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(systemReleaseAtomFixture("v1.2.3", "2026-05-27T00:00:00Z"))),
				}, nil
			}),
		},
	}
	releases, err := client.FetchReleases(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if captured == nil {
		t.Fatal("expected request to be captured")
	}
	if captured.URL.Host != "github.com" || captured.URL.Path != "/zhiyingzzhou/renewlet/releases.atom" {
		t.Fatalf("request URL = %s", captured.URL.String())
	}
	if got := captured.Header.Get("Accept"); got != "application/atom+xml" {
		t.Fatalf("Accept = %q", got)
	}
	if got := captured.Header.Get("X-GitHub-Api-Version"); got != "" {
		t.Fatalf("X-GitHub-Api-Version = %q", got)
	}
	if got := captured.Header.Get("User-Agent"); got == "" || !strings.HasPrefix(got, "Renewlet/") {
		t.Fatalf("User-Agent = %q", got)
	}
	if got := captured.Header.Get("Authorization"); got != "" {
		t.Fatalf("Authorization = %q", got)
	}
	if len(releases) != 1 || releases[0].TagName != "v1.2.3" || releases[0].Body == "" {
		t.Fatalf("unexpected parsed releases: %#v", releases)
	}
}

func TestSystemVersionWarningDoesNotExposeGitHubStatus(t *testing.T) {
	service := newSystemUpdateService(&fakeSystemReleaseClient{})
	service.now = func() time.Time { return time.Unix(1_779_820_800, 0) }
	warning := service.versionCheckWarning(localeZhCN, &systemReleaseCheckError{
		statusCode: http.StatusForbidden,
		status:     "403 Forbidden",
	})

	if strings.Contains(warning, "403") || strings.Contains(warning, "Forbidden") {
		t.Fatalf("warning leaked HTTP status: %q", warning)
	}
	if strings.Contains(strings.ToLower(warning), "token") || strings.Contains(warning, "API") {
		t.Fatalf("warning should not mention REST/token fallback, got %q", warning)
	}
}
