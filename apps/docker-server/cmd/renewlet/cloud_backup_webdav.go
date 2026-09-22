package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/studio-b12/gowebdav"
)

// WebDAV 只在 adapter 边界承接协议兼容；业务层继续只处理 snapshot zip、manifest 和上游响应脱敏。
type webDAVCloudBackupClient struct {
	settings cloudBackupWebDAVSettings
	password string
	client   *gowebdav.Client
	capture  *webDAVProviderResponseCapture
}

type webDAVProviderResponseCapture struct {
	mu            sync.Mutex
	response      *cloudBackupProviderResponse
	attemptedHost string
	localError    string
	ctx           context.Context
}

type webDAVCaptureTransport struct {
	base    http.RoundTripper
	capture *webDAVProviderResponseCapture
	secrets []string
}

func newWebDAVCloudBackupClient(settings cloudBackupWebDAVSettings, password string) *webDAVCloudBackupClient {
	capture := &webDAVProviderResponseCapture{}
	sdkClient := gowebdav.NewClient(settings.URL, settings.Username, password)
	sdkClient.SetTimeout(45 * time.Second)
	// gowebdav 负责 PROPFIND/PUT/GET 协议；custom transport 只收敛超时、TLS/代理策略和脱敏诊断。
	sdkClient.SetTransport(&webDAVCaptureTransport{
		base:    defaultUpstreamHTTPTransport(),
		capture: capture,
		secrets: []string{password},
	})
	return &webDAVCloudBackupClient{
		settings: settings,
		password: password,
		client:   sdkClient,
		capture:  capture,
	}
}

func (client *webDAVCloudBackupClient) Test(ctx context.Context) error {
	if err := client.ensureDirectory(ctx); err != nil {
		return err
	}
	name := ".renewlet-probe-" + randomHex(4) + ".txt"
	content := []byte("renewlet-cloud-backup-probe")
	if err := client.put(ctx, name, content); err != nil {
		return err
	}
	defer func() { _ = client.delete(ctx, name) }()
	got, err := client.get(ctx, name)
	if err != nil {
		return err
	}
	if !bytes.Equal(got, content) {
		return errors.New("CLOUD_BACKUP_WEBDAV_PROBE_MISMATCH")
	}
	if err := client.delete(ctx, name); err != nil {
		return err
	}
	// 测试连接必须覆盖 PROPFIND 列表权限；只验证写读删会漏掉只允许对象操作的 WebDAV 账号。
	_, err = client.List(ctx)
	return err
}

func (client *webDAVCloudBackupClient) List(ctx context.Context) ([]cloudBackupSnapshotManifest, error) {
	if err := client.ensureDirectory(ctx); err != nil {
		return nil, err
	}
	files, err := client.readDir(ctx, client.remotePath(""))
	if err != nil {
		return nil, err
	}
	manifests := []cloudBackupSnapshotManifest{}
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".manifest.json") {
			continue
		}
		manifest, err := client.readManifest(ctx, file.Name())
		if err == nil && manifest.ID != "" {
			manifests = append(manifests, manifest)
		}
	}
	return manifests, nil
}

func (client *webDAVCloudBackupClient) Upload(ctx context.Context, filename string, source cloudBackupSnapshotSource, manifest cloudBackupSnapshotManifest) error {
	if err := client.ensureDirectory(ctx); err != nil {
		return err
	}
	if err := client.putSource(ctx, filename, source); err != nil {
		return err
	}
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	return client.put(ctx, manifestNameForSnapshotID(manifest.ID), manifestBytes)
}

func (client *webDAVCloudBackupClient) putSource(ctx context.Context, filename string, source cloudBackupSnapshotSource) error {
	reader, err := source.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	return client.captureWebDAVError(ctx, "CLOUD_BACKUP_WEBDAV_PUT_FAILED", func() error {
		return client.client.WriteStreamWithLength(client.remotePath(filename), reader, source.Size(), 0o644)
	})
}

func (client *webDAVCloudBackupClient) Download(ctx context.Context, id string) ([]byte, cloudBackupSnapshotManifest, error) {
	manifest, err := client.readManifest(ctx, manifestNameForSnapshotID(id))
	if err != nil {
		return nil, cloudBackupSnapshotManifest{}, err
	}
	content, err := client.get(ctx, manifest.Filename)
	if err != nil {
		return nil, cloudBackupSnapshotManifest{}, err
	}
	return content, manifest, nil
}

func (client *webDAVCloudBackupClient) Delete(ctx context.Context, id string) error {
	if err := client.delete(ctx, snapshotFilenameForID(id)); err != nil && !errors.Is(err, errWebDAVNotFound) {
		return err
	}
	if err := client.delete(ctx, manifestNameForSnapshotID(id)); err != nil && !errors.Is(err, errWebDAVNotFound) {
		return err
	}
	return nil
}

var errWebDAVNotFound = errors.New("CLOUD_BACKUP_WEBDAV_NOT_FOUND")

func (client *webDAVCloudBackupClient) readManifest(ctx context.Context, filename string) (cloudBackupSnapshotManifest, error) {
	data, err := client.get(ctx, filename)
	if err != nil {
		return cloudBackupSnapshotManifest{}, err
	}
	var manifest cloudBackupSnapshotManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return cloudBackupSnapshotManifest{}, err
	}
	return manifest, nil
}

func (client *webDAVCloudBackupClient) ensureDirectory(ctx context.Context) error {
	return client.captureWebDAVError(ctx, "CLOUD_BACKUP_WEBDAV_MKCOL_FAILED", func() error {
		return client.client.MkdirAll(client.remotePath(""), 0o755)
	})
}

func (client *webDAVCloudBackupClient) readDir(ctx context.Context, remotePath string) ([]os.FileInfo, error) {
	var files []os.FileInfo
	err := client.captureWebDAVError(ctx, "CLOUD_BACKUP_WEBDAV_PROPFIND_FAILED", func() error {
		var err error
		files, err = client.client.ReadDir(remotePath)
		return err
	})
	return files, err
}

func (client *webDAVCloudBackupClient) put(ctx context.Context, filename string, content []byte) error {
	return client.captureWebDAVError(ctx, "CLOUD_BACKUP_WEBDAV_PUT_FAILED", func() error {
		return client.client.WriteStreamWithLength(client.remotePath(filename), bytes.NewReader(content), int64(len(content)), 0o644)
	})
}

func (client *webDAVCloudBackupClient) get(ctx context.Context, filename string) ([]byte, error) {
	var stream io.ReadCloser
	err := client.captureWebDAVError(ctx, "CLOUD_BACKUP_WEBDAV_GET_FAILED", func() error {
		var err error
		stream, err = client.client.ReadStream(client.remotePath(filename))
		return err
	})
	if err != nil {
		return nil, err
	}
	defer stream.Close()
	data, err := io.ReadAll(io.LimitReader(stream, cloudBackupSnapshotMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > cloudBackupSnapshotMaxBytes {
		return nil, errors.New("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE")
	}
	return data, nil
}

func (client *webDAVCloudBackupClient) delete(ctx context.Context, filename string) error {
	err := client.captureWebDAVError(ctx, "CLOUD_BACKUP_WEBDAV_DELETE_FAILED", func() error {
		return client.client.Remove(client.remotePath(filename))
	})
	if isWebDAVNotFoundError(err) {
		return errWebDAVNotFound
	}
	return err
}

func (client *webDAVCloudBackupClient) captureWebDAVError(ctx context.Context, code string, operation func() error) error {
	client.capture.reset(ctx)
	if err := operation(); err != nil {
		if response := client.capture.last(); response != nil {
			return cloudBackupRemoteHTTPErrorFromProviderResponse(webDAVErrorCodeForStatus(code, response), response)
		}
		return client.capture.describeLocalError(code, err)
	}
	return nil
}

func (client *webDAVCloudBackupClient) remotePath(filename string) string {
	return joinWebDAVRemotePath(client.settings.Path, filename)
}

func (transport *webDAVCaptureTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	transport.capture.setAttemptedRequest(request)
	if ctx := transport.capture.currentContext(); ctx != nil {
		request = request.WithContext(ctx)
	}
	base := transport.base
	if base == nil {
		base = http.DefaultTransport
	}
	response, err := base.RoundTrip(request)
	if err != nil || response == nil {
		if err != nil {
			transport.capture.setLocalError(request, "WebDAV", err, transport.secrets, 45*time.Second)
		}
		return response, err
	}
	if response.StatusCode < 400 {
		return response, nil
	}
	// gowebdav 仍要消费错误 body 来生成自身错误；这里捕获后重放，确保 SDK 和 Renewlet raw response 契约都能拿到同一份响应。
	captured, body := cloudBackupProviderResponseAndBodyFromHTTPResponse(response, transport.secrets)
	response.Body.Close()
	response.Body = io.NopCloser(strings.NewReader(body))
	transport.capture.set(captured)
	return response, nil
}

func (capture *webDAVProviderResponseCapture) reset(ctx context.Context) {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	capture.response = nil
	capture.attemptedHost = ""
	capture.localError = ""
	capture.ctx = ctx
}

func (capture *webDAVProviderResponseCapture) set(response *cloudBackupProviderResponse) {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	capture.response = response
}

func (capture *webDAVProviderResponseCapture) last() *cloudBackupProviderResponse {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	return capture.response
}

func (capture *webDAVProviderResponseCapture) currentContext() context.Context {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	return capture.ctx
}

func (capture *webDAVProviderResponseCapture) setAttemptedRequest(request *http.Request) {
	if request == nil || request.URL == nil {
		return
	}
	capture.mu.Lock()
	defer capture.mu.Unlock()
	capture.attemptedHost = request.URL.Scheme + "://" + request.URL.Host
}

func (capture *webDAVProviderResponseCapture) setLocalError(request *http.Request, provider string, err error, secrets []string, timeout time.Duration) {
	if request == nil {
		return
	}
	timedOut := upstreamNetErrorTimedOut(err) || errors.Is(request.Context().Err(), context.DeadlineExceeded)
	// 没有 HTTP response 的 WebDAV 失败也必须走统一脱敏口径，避免 Basic Auth 或路径凭据进入 rawResponseText。
	message := upstreamTransportDiagnosticMessage(request, upstreamHTTPRequestOptions{
		Provider: provider,
		Timeout:  timeout,
		Secrets:  secrets,
	}, err, timeout, timedOut)
	capture.mu.Lock()
	defer capture.mu.Unlock()
	capture.localError = message
}

func (capture *webDAVProviderResponseCapture) describeLocalError(code string, err error) error {
	capture.mu.Lock()
	localError := capture.localError
	attemptedHost := capture.attemptedHost
	capture.mu.Unlock()
	if strings.TrimSpace(localError) != "" {
		return &cloudBackupRemoteError{
			code:    code,
			details: &cloudBackupErrorDetails{RawResponseText: optionalCloudBackupString(localError)},
		}
	}
	if attemptedHost == "" || err == nil {
		return err
	}
	return &cloudBackupRemoteError{
		code:    code,
		details: cloudBackupLocalErrorDetails(errors.New(err.Error() + " (attempted host: " + attemptedHost + ")")),
	}
}

func webDAVErrorCodeForStatus(fallback string, response *cloudBackupProviderResponse) string {
	if response != nil && response.Status != nil && *response.Status == http.StatusNotFound {
		return "CLOUD_BACKUP_WEBDAV_NOT_FOUND"
	}
	return fallback
}

func isWebDAVNotFoundError(err error) bool {
	remoteErr := cloudBackupRemoteErrorFrom(err)
	return remoteErr != nil && remoteErr.code == "CLOUD_BACKUP_WEBDAV_NOT_FOUND"
}

func joinWebDAVRemotePath(parts ...string) string {
	segments := []string{}
	for _, part := range parts {
		for _, segment := range strings.Split(strings.Trim(part, "/"), "/") {
			segment = strings.TrimSpace(segment)
			if segment != "" {
				segments = append(segments, segment)
			}
		}
	}
	if len(segments) == 0 {
		return "/"
	}
	return "/" + strings.Join(segments, "/")
}

func manifestNameForSnapshotID(id string) string {
	return strings.TrimSpace(id) + ".manifest.json"
}

func snapshotFilenameForID(id string) string {
	return strings.TrimSpace(id) + ".zip"
}
