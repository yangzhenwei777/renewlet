package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// fake client 隔离 GitHub 网络和真实下载，同时暴露计数器给拆分后的测试断言缓存与 probe 行为。
type fakeSystemReleaseClient struct {
	release       *systemRelease
	releases      []systemRelease
	fetchDelay    time.Duration
	fetchCount    int32
	probeCount    int32
	downloadCount int32
	checksumCount int32
	archiveData   []byte
	checksumTxt   []byte
	probeAssets   []systemReleaseAsset
	requestMu     sync.Mutex
	requestOrder  []string
}

func (client *fakeSystemReleaseClient) FetchReleases(ctx context.Context) ([]systemRelease, error) {
	atomic.AddInt32(&client.fetchCount, 1)
	if client.fetchDelay > 0 {
		select {
		case <-time.After(client.fetchDelay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if client.releases != nil {
		return append([]systemRelease(nil), client.releases...), nil
	}
	if client.release == nil {
		return nil, errors.New("missing release")
	}
	return []systemRelease{*client.release}, nil
}

func (client *fakeSystemReleaseClient) ProbeReleaseAssets(_ context.Context, _ string, _ string) []systemReleaseAsset {
	atomic.AddInt32(&client.probeCount, 1)
	if client.probeAssets != nil {
		return append([]systemReleaseAsset(nil), client.probeAssets...)
	}
	return nil
}

func (client *fakeSystemReleaseClient) DownloadFile(ctx context.Context, _ string, targetPath string, _ int64, _ int64) (string, error) {
	atomic.AddInt32(&client.downloadCount, 1)
	client.recordRequest("archive")
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	default:
	}
	if client.archiveData == nil {
		return "", errors.New("download not configured")
	}
	if err := os.WriteFile(targetPath, client.archiveData, 0o600); err != nil {
		return "", err
	}
	sum := sha256.Sum256(client.archiveData)
	return hex.EncodeToString(sum[:]), nil
}

func (client *fakeSystemReleaseClient) FetchText(_ context.Context, _ string, _ int64) ([]byte, error) {
	atomic.AddInt32(&client.checksumCount, 1)
	client.recordRequest("checksum")
	return client.checksumTxt, nil
}

func (client *fakeSystemReleaseClient) recordRequest(kind string) {
	client.requestMu.Lock()
	defer client.requestMu.Unlock()
	client.requestOrder = append(client.requestOrder, kind)
}

func (client *fakeSystemReleaseClient) recordedRequests() []string {
	client.requestMu.Lock()
	defer client.requestMu.Unlock()
	return append([]string(nil), client.requestOrder...)
}

func (service *systemUpdateService) downloadFnForTest(binaryContent string) {
	if fake, ok := service.client.(*fakeSystemReleaseClient); ok {
		archiveData, err := tarGzBytes(map[string]string{"renewlet": binaryContent})
		if err != nil {
			panic(err)
		}
		archiveName := fakeArchiveName(fake)
		if archiveName == "" {
			panic("fake release archive is missing")
		}
		fake.archiveData = archiveData
		sum := sha256.Sum256(archiveData)
		fake.checksumTxt = []byte(hex.EncodeToString(sum[:]) + "  " + archiveName + "\n")
	}
}

func writeTarGz(path string, files map[string]string) error {
	data, err := tarGzBytes(files)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func tarGzBytes(files map[string]string) ([]byte, error) {
	// 自更新包必须保留可执行权限，避免测试通过但容器重启后 /opt/renewlet/current/renewlet 无法执行。
	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	tarWriter := tar.NewWriter(gzipWriter)
	for name, content := range files {
		if err := tarWriter.WriteHeader(&tar.Header{
			Name: name,
			Mode: 0o755,
			Size: int64(len(content)),
		}); err != nil {
			return nil, err
		}
		if _, err := tarWriter.Write([]byte(content)); err != nil {
			return nil, err
		}
	}
	if err := tarWriter.Close(); err != nil {
		return nil, err
	}
	if err := gzipWriter.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func fakeArchiveName(client *fakeSystemReleaseClient) string {
	releases := client.releases
	if client.release != nil {
		releases = []systemRelease{*client.release}
	}
	for _, release := range releases {
		for _, asset := range release.Assets {
			if asset.Name != "checksums.txt" {
				return asset.Name
			}
		}
	}
	return ""
}

func releaseFixture(tag string) systemRelease {
	version := strings.TrimPrefix(tag, "v")
	// fixture 固定 Release 资产命名，保护 Docker 页面内更新对 archive/checksums 的查找契约。
	return systemRelease{
		TagName:     tag,
		Name:        "Renewlet " + version,
		PublishedAt: "2026-06-04T00:00:00Z",
		HTMLURL:     "https://github.com/zhiyingzzhou/renewlet/releases/tag/" + tag,
		Assets: []systemReleaseAsset{
			{Name: systemArchiveName(version), BrowserDownloadURL: "https://github.com/zhiyingzzhou/renewlet/releases/download/" + tag + "/" + systemArchiveName(version)},
			{Name: "checksums.txt", BrowserDownloadURL: "https://github.com/zhiyingzzhou/renewlet/releases/download/" + tag + "/checksums.txt"},
		},
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func systemReleaseAtomFixture(tag string, updated string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <updated>` + updated + `</updated>
    <link rel="alternate" type="text/html" href="https://github.com/zhiyingzzhou/renewlet/releases/tag/` + tag + `"/>
    <title>` + tag + `</title>
    <content type="html">&lt;p&gt;Release notes&lt;/p&gt;</content>
  </entry>
</feed>`
}
