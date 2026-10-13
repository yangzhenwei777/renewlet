package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
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
	mu              sync.Mutex
	response        *cloudBackupProviderResponse
	baseURL         string
	attemptedHost   string
	attemptedTarget string
	operation       string
	localError      string
	ctx             context.Context
}

type webDAVCaptureTransport struct {
	base    http.RoundTripper
	capture *webDAVProviderResponseCapture
	secrets []string
}

func newWebDAVCloudBackupClient(settings cloudBackupWebDAVSettings, password string) *webDAVCloudBackupClient {
	capture := &webDAVProviderResponseCapture{}
	capture.baseURL = settings.URL
	sdkClient := gowebdav.NewClient(settings.URL, settings.Username, password)
	sdkClient.SetTimeout(45 * time.Second)
	// gowebdav 负责 PROPFIND/PUT/GET 协议；custom transport 只收敛超时、TLS/代理策略和脱敏诊断。
	sdkClient.SetTransport(&webDAVCaptureTransport{
		base:    defaultUpstreamHTTPTransport(),
		capture: capture,
		secrets: []string{settings.Username, password},
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
	deleted := false
	cleanupCtx, cancelCleanup := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancelCleanup()
	defer func() {
		if !deleted {
			_ = client.delete(cleanupCtx, name)
		}
	}()
	got, err := client.get(ctx, name)
	if err != nil {
		return err
	}
	if !bytes.Equal(got, content) {
		return &cloudBackupRemoteError{
			code: "CLOUD_BACKUP_WEBDAV_PROBE_MISMATCH",
			details: cloudBackupLocalErrorDetails(
				"webdav",
				"GET",
				client.remoteTarget(client.remotePath(name)),
				"Probe object content does not match the uploaded bytes.",
			),
		}
	}
	if err := client.delete(ctx, name); err != nil {
		return err
	}
	deleted = true
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
		if err != nil {
			return nil, err
		}
		if err := validateCloudBackupManifest(manifest); err != nil {
			return nil, cloudBackupDiagnosticError("CLOUD_BACKUP_MANIFEST_INVALID", "webdav", "manifest", client.remoteTarget(client.remotePath(file.Name())), err.Error())
		}
		manifests = append(manifests, manifest)
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
	// manifest 是列表可见性的提交点；先用协议库的 PROPFIND 校验远端大小，失败时回收已经写入的 ZIP。
	size, err := client.stat(ctx, filename)
	if err != nil {
		return cloudBackupErrorWithCleanup(err, client.cleanupUploadedFiles(ctx, filename))
	}
	if size != source.Size() {
		mismatch := &cloudBackupRemoteError{
			code: "CLOUD_BACKUP_WEBDAV_STAT_MISMATCH",
			details: cloudBackupLocalErrorDetails(
				"webdav",
				"PROPFIND",
				client.remoteTarget(client.remotePath(filename)),
				fmt.Sprintf("Remote size %d bytes does not match uploaded size %d bytes.", size, source.Size()),
			),
		}
		return cloudBackupErrorWithCleanup(mismatch, client.cleanupUploadedFiles(ctx, filename))
	}
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return cloudBackupErrorWithCleanup(err, client.cleanupUploadedFiles(ctx, filename))
	}
	manifestFilename := manifestNameForSnapshotID(manifest.ID)
	if err := client.put(ctx, manifestFilename, manifestBytes); err != nil {
		return cloudBackupErrorWithCleanup(err, client.cleanupUploadedFiles(ctx, filename, manifestFilename))
	}
	return nil
}

func (client *webDAVCloudBackupClient) putSource(ctx context.Context, filename string, source cloudBackupSnapshotSource) error {
	reader, err := source.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	return client.captureWebDAVError(ctx, "CLOUD_BACKUP_WEBDAV_PUT_FAILED", "PUT", client.remotePath(filename), func() error {
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
	if err := client.delete(ctx, snapshotFilenameForID(id)); err != nil && !isWebDAVNotFoundError(err) {
		return err
	}
	if err := client.delete(ctx, manifestNameForSnapshotID(id)); err != nil && !isWebDAVNotFoundError(err) {
		return err
	}
	return nil
}

func (client *webDAVCloudBackupClient) readManifest(ctx context.Context, filename string) (cloudBackupSnapshotManifest, error) {
	data, err := client.get(ctx, filename)
	if err != nil {
		return cloudBackupSnapshotManifest{}, err
	}
	var manifest cloudBackupSnapshotManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return cloudBackupSnapshotManifest{}, cloudBackupDiagnosticError("CLOUD_BACKUP_MANIFEST_INVALID", "webdav", "manifest", client.remoteTarget(client.remotePath(filename)), err.Error())
	}
	if err := validateCloudBackupManifest(manifest); err != nil {
		return cloudBackupSnapshotManifest{}, cloudBackupDiagnosticError("CLOUD_BACKUP_MANIFEST_INVALID", "webdav", "manifest", client.remoteTarget(client.remotePath(filename)), err.Error())
	}
	return manifest, nil
}

func (client *webDAVCloudBackupClient) ensureDirectory(ctx context.Context) error {
	return client.captureWebDAVError(ctx, "CLOUD_BACKUP_WEBDAV_MKCOL_FAILED", "MKCOL", client.remotePath(""), func() error {
		return client.client.MkdirAll(client.remotePath(""), 0o755)
	})
}

func (client *webDAVCloudBackupClient) readDir(ctx context.Context, remotePath string) ([]os.FileInfo, error) {
	var files []os.FileInfo
	err := client.captureWebDAVError(ctx, "CLOUD_BACKUP_WEBDAV_PROPFIND_FAILED", "PROPFIND", remotePath, func() error {
		var err error
		files, err = client.client.ReadDir(remotePath)
		return err
	})
	return files, err
}

func (client *webDAVCloudBackupClient) put(ctx context.Context, filename string, content []byte) error {
	return client.captureWebDAVError(ctx, "CLOUD_BACKUP_WEBDAV_PUT_FAILED", "PUT", client.remotePath(filename), func() error {
		return client.client.WriteStreamWithLength(client.remotePath(filename), bytes.NewReader(content), int64(len(content)), 0o644)
	})
}

func (client *webDAVCloudBackupClient) stat(ctx context.Context, filename string) (int64, error) {
	path := client.remotePath(filename)
	var info os.FileInfo
	err := client.captureWebDAVError(ctx, "CLOUD_BACKUP_WEBDAV_PROPFIND_FAILED", "PROPFIND", path, func() error {
		var err error
		info, err = client.client.Stat(path)
		return err
	})
	if err != nil {
		return 0, err
	}
	if info == nil || info.IsDir() || info.Size() < 0 {
		return 0, &cloudBackupRemoteError{
			code: "CLOUD_BACKUP_WEBDAV_STAT_INVALID",
			details: cloudBackupLocalErrorDetails(
				"webdav",
				"PROPFIND",
				client.remoteTarget(path),
				"Remote metadata is missing or does not describe a regular file.",
			),
		}
	}
	return info.Size(), nil
}

func (client *webDAVCloudBackupClient) get(ctx context.Context, filename string) ([]byte, error) {
	path := client.remotePath(filename)
	var stream io.ReadCloser
	err := client.captureWebDAVError(ctx, "CLOUD_BACKUP_WEBDAV_GET_FAILED", "GET", path, func() error {
		var err error
		stream, err = client.client.ReadStream(path)
		return err
	})
	if err != nil {
		return nil, err
	}
	defer stream.Close()
	data, err := io.ReadAll(io.LimitReader(stream, cloudBackupSnapshotMaxBytes+1))
	if err != nil {
		return nil, cloudBackupDiagnosticError("CLOUD_BACKUP_WEBDAV_GET_FAILED", "webdav", "GET", client.remoteTarget(path), err.Error())
	}
	if int64(len(data)) > cloudBackupSnapshotMaxBytes {
		return nil, cloudBackupDiagnosticError("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE", "webdav", "GET", client.remoteTarget(path), "Remote object exceeds the 16 MiB snapshot limit.")
	}
	return data, nil
}

func (client *webDAVCloudBackupClient) delete(ctx context.Context, filename string) error {
	err := client.captureWebDAVError(ctx, "CLOUD_BACKUP_WEBDAV_DELETE_FAILED", "DELETE", client.remotePath(filename), func() error {
		return client.client.Remove(client.remotePath(filename))
	})
	return err
}

func (client *webDAVCloudBackupClient) cleanupUploadedFiles(ctx context.Context, filenames ...string) []cloudBackupCleanupError {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	cleanup := make([]cloudBackupCleanupError, 0, len(filenames))
	for _, filename := range filenames {
		if err := client.delete(cleanupCtx, filename); err != nil && !isWebDAVNotFoundError(err) {
			cleanup = append(cleanup, formatCloudBackupCleanupError("DELETE", client.remoteTarget(client.remotePath(filename)), err))
		}
	}
	return cleanup
}

func (client *webDAVCloudBackupClient) captureWebDAVError(ctx context.Context, code string, operation string, target string, request func() error) error {
	client.capture.reset(ctx, operation, target)
	if err := request(); err != nil {
		if response := client.capture.last(); response != nil {
			return &cloudBackupRemoteError{code: code, details: cloudBackupRemoteErrorDetails("webdav", operation, client.capture.target(), response, "")}
		}
		return client.capture.describeLocalError(code, err)
	}
	return nil
}

func (client *webDAVCloudBackupClient) remotePath(filename string) string {
	return joinWebDAVRemotePath(client.settings.Path, filename)
}

func (client *webDAVCloudBackupClient) remoteTarget(remotePath string) string {
	parsed, err := url.Parse(client.settings.URL)
	if err != nil || parsed.Host == "" {
		return remotePath
	}
	return "host=" + parsed.Host + "; path=" + joinWebDAVRemotePath(parsed.Path, remotePath)
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

func (capture *webDAVProviderResponseCapture) reset(ctx context.Context, operation string, target string) {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	capture.response = nil
	capture.attemptedHost = ""
	capture.attemptedTarget = target
	capture.operation = operation
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

func (capture *webDAVProviderResponseCapture) target() string {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	if strings.HasPrefix(capture.attemptedTarget, "/") && capture.baseURL != "" {
		if base, err := http.NewRequest(http.MethodGet, capture.baseURL, nil); err == nil && base.URL != nil {
			return base.URL.Scheme + "://" + base.URL.Host + capture.attemptedTarget
		}
	}
	return capture.attemptedTarget
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
	capture.attemptedTarget = capture.attemptedHost + request.URL.EscapedPath()
}

func (capture *webDAVProviderResponseCapture) setLocalError(request *http.Request, provider string, err error, secrets []string, timeout time.Duration) {
	if request == nil {
		return
	}
	timedOut := upstreamNetErrorTimedOut(err) || errors.Is(request.Context().Err(), context.DeadlineExceeded)
	// 没有 HTTP response 的 WebDAV 失败也必须走统一脱敏口径，避免 Basic Auth 或路径凭据进入 providerMessage。
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
	attemptedTarget := capture.attemptedTarget
	operation := capture.operation
	capture.mu.Unlock()
	if strings.TrimSpace(localError) != "" {
		return &cloudBackupRemoteError{code: code, details: cloudBackupLocalErrorDetails("webdav", operation, attemptedTarget, localError)}
	}
	if attemptedHost == "" || err == nil {
		return err
	}
	return &cloudBackupRemoteError{code: code, details: cloudBackupLocalErrorDetails("webdav", operation, attemptedTarget, operation+" failed: "+err.Error())}
}

func isWebDAVNotFoundError(err error) bool {
	remoteErr := cloudBackupRemoteErrorFrom(err)
	return remoteErr != nil && remoteErr.details != nil && remoteErr.details.HTTPStatus != nil && *remoteErr.details.HTTPStatus == http.StatusNotFound
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
