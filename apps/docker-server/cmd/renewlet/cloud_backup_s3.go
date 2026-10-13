package main

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// ListObjectsV2 XML 只包含对象元数据；独立 1 MiB 上限避免异常 provider 响应占用快照读取配额。
const cloudBackupS3ListResponseMaxBytes int64 = 1 << 20

// s3ObjectStore 是 AWS SDK 的唯一传输边界。endpoint、寻址、签名、序列化和反序列化都交给 SDK；
// 这里仅负责固定的对象操作、有限响应捕获和脱敏诊断，避免业务流程重新实现 S3 协议。
type s3ObjectStore struct {
	settings cloudBackupS3Settings
	secret   string
	client   *s3.Client
	capture  *s3ProviderResponseCapture
}

// s3CloudBackupClient 只编排 Renewlet 的对象命名空间和 manifest 状态机。
// 嵌入传输层保留现有测试的 client.client/client.capture 注入点，同时不让业务层依赖 HTTP 细节。
type s3CloudBackupClient struct {
	*s3ObjectStore
}

type s3ProviderResponseCapture struct {
	mu              sync.Mutex
	response        *cloudBackupProviderResponse
	attemptedHost   string
	attemptedTarget string
	localError      string
	localCode       string
	operation       string
	bucket          string
	key             string
	endpoint        string
}

type s3CaptureHTTPClient struct {
	client          *http.Client
	capture         *s3ProviderResponseCapture
	secrets         []string
	bucket          string
	addressingStyle string
}

func newS3CloudBackupClient(settings cloudBackupS3Settings, secret string) *s3CloudBackupClient {
	capture := &s3ProviderResponseCapture{}
	store := &s3ObjectStore{
		settings: settings,
		secret:   secret,
		capture:  capture,
	}
	// SDK 负责 endpoint resolver 和 SigV4；transport 只统一超时、脱敏和 virtualHost 配置校验。
	httpClient := &s3CaptureHTTPClient{
		client:          defaultUpstreamHTTPClient(45 * time.Second),
		capture:         capture,
		secrets:         []string{settings.AccessKeyID, secret},
		bucket:          settings.Bucket,
		addressingStyle: settings.AddressingStyle,
	}
	store.client = newS3SDKClient(settings, secret, httpClient)
	return &s3CloudBackupClient{s3ObjectStore: store}
}

func newS3SDKClient(settings cloudBackupS3Settings, secret string, httpClient aws.HTTPClient) *s3.Client {
	return s3.NewFromConfig(aws.Config{
		Region:                     settings.Region,
		Credentials:                aws.NewCredentialsCache(credentials.NewStaticCredentialsProvider(settings.AccessKeyID, secret, "")),
		HTTPClient:                 httpClient,
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
	}, func(options *s3.Options) {
		// BaseEndpoint 和 UsePathStyle 是 SDK 的公开配置；auto 保持 SDK 原生 endpoint 规则，不再按 URL 外形猜测。
		options.BaseEndpoint = aws.String(settings.Endpoint)
		options.UsePathStyle = settings.AddressingStyle == cloudBackupS3AddressingPathStyle
		options.RetryMaxAttempts = 1
	})
}

func (client *s3CloudBackupClient) Test(ctx context.Context) error {
	name := client.key(".renewlet-probe-" + randomHex(4) + ".txt")
	content := []byte("renewlet-cloud-backup-probe")
	if err := client.putObject(ctx, name, content); err != nil {
		return err
	}
	deleted := false
	cleanupCtx, cancelCleanup := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancelCleanup()
	defer func() {
		if !deleted {
			_ = client.deleteObject(cleanupCtx, name)
		}
	}()
	size, err := client.headObject(ctx, name)
	if err != nil {
		return err
	}
	if size != int64(len(content)) {
		return &cloudBackupRemoteError{
			code:    "CLOUD_BACKUP_S3_PROBE_MISMATCH",
			details: cloudBackupLocalErrorDetails("s3", "HeadObject", client.target(name), fmt.Sprintf("Remote size %d bytes does not match probe size %d bytes.", size, len(content))),
		}
	}
	got, err := client.getObject(ctx, name)
	if err != nil {
		return err
	}
	if !bytes.Equal(got, content) {
		return &cloudBackupRemoteError{
			code:    "CLOUD_BACKUP_S3_PROBE_MISMATCH",
			details: cloudBackupLocalErrorDetails("s3", "GetObject", client.target(name), "Probe object content does not match the uploaded bytes."),
		}
	}
	if err := client.deleteObject(ctx, name); err != nil {
		return err
	}
	deleted = true
	// 测试连接必须覆盖 ListBucket 权限；成功路径仍只发一次根列表请求。
	_, err = client.listObjects(ctx, client.key(""))
	return err
}

func (client *s3CloudBackupClient) List(ctx context.Context) ([]cloudBackupSnapshotManifest, error) {
	keys, err := client.listObjects(ctx, client.key(""))
	if err != nil {
		return nil, err
	}
	manifests := make([]cloudBackupSnapshotManifest, 0, len(keys))
	for _, key := range keys {
		if !strings.HasSuffix(key, ".manifest.json") {
			continue
		}
		data, err := client.getObject(ctx, key)
		if err != nil {
			return nil, err
		}
		var manifest cloudBackupSnapshotManifest
		if err := json.Unmarshal(data, &manifest); err != nil {
			return nil, cloudBackupDiagnosticError("CLOUD_BACKUP_MANIFEST_INVALID", "s3", "manifest", client.target(key), err.Error())
		}
		if err := validateCloudBackupManifest(manifest); err != nil {
			return nil, cloudBackupDiagnosticError("CLOUD_BACKUP_MANIFEST_INVALID", "s3", "manifest", client.target(key), err.Error())
		}
		manifests = append(manifests, manifest)
	}
	return manifests, nil
}

func (client *s3CloudBackupClient) Upload(ctx context.Context, filename string, source cloudBackupSnapshotSource, manifest cloudBackupSnapshotManifest) error {
	// ZIP 只有在 manifest sidecar 提交成功后才可被列表发现；失败路径清理所有已尝试对象。
	zipKey := client.key(filename)
	if err := client.putObjectSource(ctx, zipKey, source); err != nil {
		return err
	}
	manifestKey := client.key(manifestNameForSnapshotID(manifest.ID))
	size, err := client.headObject(ctx, zipKey)
	if err != nil {
		return cloudBackupErrorWithCleanup(err, client.cleanupUploadedObjects(ctx, zipKey))
	}
	if size != source.Size() {
		mismatch := &cloudBackupRemoteError{
			code:    "CLOUD_BACKUP_S3_HEAD_MISMATCH",
			details: cloudBackupLocalErrorDetails("s3", "HeadObject", client.target(zipKey), fmt.Sprintf("Remote size %d bytes does not match uploaded size %d bytes.", size, source.Size())),
		}
		return cloudBackupErrorWithCleanup(mismatch, client.cleanupUploadedObjects(ctx, zipKey))
	}
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return cloudBackupErrorWithCleanup(err, client.cleanupUploadedObjects(ctx, zipKey))
	}
	if err := client.putObject(ctx, manifestKey, manifestBytes); err != nil {
		return cloudBackupErrorWithCleanup(err, client.cleanupUploadedObjects(ctx, zipKey, manifestKey))
	}
	return nil
}

func (client *s3ObjectStore) putObjectSource(ctx context.Context, key string, source cloudBackupSnapshotSource) error {
	reader, err := source.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	return client.call(ctx, "CLOUD_BACKUP_S3_PUT_FAILED", "PutObject", key, func() error {
		_, err := client.client.PutObject(ctx, &s3.PutObjectInput{
			Bucket:        aws.String(client.settings.Bucket),
			Key:           aws.String(key),
			Body:          reader,
			ContentLength: aws.Int64(source.Size()),
			ContentType:   aws.String(contentTypeForS3Key(key)),
		})
		return err
	})
}

func (client *s3CloudBackupClient) Download(ctx context.Context, id string) ([]byte, cloudBackupSnapshotManifest, error) {
	manifestBytes, err := client.getObject(ctx, client.key(manifestNameForSnapshotID(id)))
	if err != nil {
		return nil, cloudBackupSnapshotManifest{}, err
	}
	var manifest cloudBackupSnapshotManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return nil, cloudBackupSnapshotManifest{}, cloudBackupDiagnosticError("CLOUD_BACKUP_MANIFEST_INVALID", "s3", "manifest", client.target(client.key(manifestNameForSnapshotID(id))), err.Error())
	}
	if err := validateCloudBackupManifest(manifest); err != nil {
		return nil, cloudBackupSnapshotManifest{}, cloudBackupDiagnosticError("CLOUD_BACKUP_MANIFEST_INVALID", "s3", "manifest", client.target(client.key(manifestNameForSnapshotID(id))), err.Error())
	}
	content, err := client.getObject(ctx, client.key(manifest.Filename))
	if err != nil {
		return nil, cloudBackupSnapshotManifest{}, err
	}
	return content, manifest, nil
}

func (client *s3CloudBackupClient) Delete(ctx context.Context, id string) error {
	if err := client.deleteObject(ctx, client.key(snapshotFilenameForID(id))); err != nil && !isS3NotFoundError(err) {
		return err
	}
	if err := client.deleteObject(ctx, client.key(manifestNameForSnapshotID(id))); err != nil && !isS3NotFoundError(err) {
		return err
	}
	return nil
}

func (client *s3CloudBackupClient) key(filename string) string {
	prefix := ""
	if client.settings.Prefix != nil {
		prefix = strings.Trim(*client.settings.Prefix, "/")
	}
	filename = strings.Trim(filename, "/")
	if prefix == "" {
		return filename
	}
	if filename == "" {
		return prefix + "/"
	}
	return prefix + "/" + filename
}

func (client *s3ObjectStore) target(key string) string {
	return "host=" + cloudBackupEndpointHost(client.settings.Endpoint) + "; bucket=" + client.settings.Bucket + "; key=" + cloudBackupObjectTargetKey(key)
}

func (client *s3ObjectStore) listObjects(ctx context.Context, prefix string) ([]string, error) {
	const pageSize int32 = 1000
	keys := make([]string, 0, pageSize)
	var continuationToken string
	seenTokens := map[string]struct{}{}
	for {
		input := &s3.ListObjectsV2Input{
			Bucket:  aws.String(client.settings.Bucket),
			MaxKeys: aws.Int32(pageSize),
		}
		if prefix != "" {
			input.Prefix = aws.String(prefix)
		}
		if continuationToken != "" {
			input.ContinuationToken = aws.String(continuationToken)
		}
		var page *s3.ListObjectsV2Output
		err := client.call(ctx, "CLOUD_BACKUP_S3_LIST_FAILED", "ListObjectsV2", prefix, func() error {
			var err error
			page, err = client.client.ListObjectsV2(ctx, input)
			return err
		})
		if err != nil {
			return nil, err
		}
		if page == nil {
			return nil, errors.New("CLOUD_BACKUP_S3_LIST_RESPONSE_INVALID")
		}
		for _, item := range page.Contents {
			if item.Key != nil {
				keys = append(keys, *item.Key)
			}
		}
		next := aws.ToString(page.NextContinuationToken)
		if next == "" {
			return keys, nil
		}
		if _, exists := seenTokens[next]; exists {
			return keys, nil
		}
		seenTokens[next] = struct{}{}
		continuationToken = next
	}
}

func (client *s3ObjectStore) putObject(ctx context.Context, key string, content []byte) error {
	return client.call(ctx, "CLOUD_BACKUP_S3_PUT_FAILED", "PutObject", key, func() error {
		_, err := client.client.PutObject(ctx, &s3.PutObjectInput{
			Bucket:      aws.String(client.settings.Bucket),
			Key:         aws.String(key),
			Body:        bytes.NewReader(content),
			ContentType: aws.String(contentTypeForS3Key(key)),
		})
		return err
	})
}

func (client *s3ObjectStore) getObject(ctx context.Context, key string) ([]byte, error) {
	var output *s3.GetObjectOutput
	if err := client.call(ctx, "CLOUD_BACKUP_S3_GET_FAILED", "GetObject", key, func() error {
		var err error
		output, err = client.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(client.settings.Bucket), Key: aws.String(key)})
		return err
	}); err != nil {
		return nil, err
	}
	if output == nil || output.Body == nil {
		return nil, client.capture.describeLocalError("CLOUD_BACKUP_S3_GET_FAILED", errors.New("S3 GetObject returned an empty body"), client.settings.AccessKeyID, client.secret)
	}
	defer output.Body.Close()
	data, err := io.ReadAll(io.LimitReader(output.Body, cloudBackupSnapshotMaxBytes+1))
	if err != nil {
		return nil, client.capture.describeLocalError("CLOUD_BACKUP_S3_GET_FAILED", err, client.settings.AccessKeyID, client.secret)
	}
	if int64(len(data)) > cloudBackupSnapshotMaxBytes {
		return nil, cloudBackupDiagnosticError("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE", "s3", "GetObject", client.target(key), "Remote object exceeds the 16 MiB snapshot limit.")
	}
	return data, nil
}

func (client *s3ObjectStore) headObject(ctx context.Context, key string) (int64, error) {
	var output *s3.HeadObjectOutput
	if err := client.call(ctx, "CLOUD_BACKUP_S3_HEAD_FAILED", "HeadObject", key, func() error {
		var err error
		output, err = client.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(client.settings.Bucket), Key: aws.String(key)})
		return err
	}); err != nil {
		return 0, err
	}
	if output.ContentLength == nil {
		return -1, nil
	}
	return *output.ContentLength, nil
}

func (client *s3ObjectStore) deleteObject(ctx context.Context, key string) error {
	err := client.call(ctx, "CLOUD_BACKUP_S3_DELETE_FAILED", "DeleteObject", key, func() error {
		_, err := client.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(client.settings.Bucket), Key: aws.String(key)})
		return err
	})
	if isS3NotFoundError(err) {
		return nil
	}
	return err
}

func (client *s3ObjectStore) call(ctx context.Context, code string, operation string, key string, request func() error) error {
	client.capture.reset()
	client.capture.setOperation(operation, client.settings.Endpoint, client.settings.Bucket, key)
	if err := request(); err != nil {
		if response := client.capture.last(); response != nil {
			if response.Status != nil && *response.Status >= http.StatusBadRequest {
				return &cloudBackupRemoteError{code: code, details: client.capture.responseDetails(response)}
			}
			if localError := client.capture.localErrorValue(); localError != "" {
				return &cloudBackupRemoteError{code: code, details: client.capture.responseDetailsWithClientMessage(response, localError)}
			}
			message := "SDK error: " + redactUpstreamSecrets(errorMessage(err), []string{client.settings.AccessKeyID, client.secret})
			return &cloudBackupRemoteError{code: code, details: client.capture.responseDetailsWithClientMessage(response, message)}
		}
		return client.capture.describeLocalError(code, err, client.settings.AccessKeyID, client.secret)
	}
	return nil
}

func (client *s3CloudBackupClient) cleanupUploadedObjects(ctx context.Context, keys ...string) []cloudBackupCleanupError {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	cleanup := make([]cloudBackupCleanupError, 0, len(keys))
	for _, key := range keys {
		if err := client.deleteObject(cleanupCtx, key); err != nil {
			cleanup = append(cleanup, formatCloudBackupCleanupError("DeleteObject", client.target(key), err))
		}
	}
	return cleanup
}

func (client *s3CaptureHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.capture.setAttemptedRequest(request)
	if client.addressingStyle == cloudBackupS3AddressingVirtualHost && !s3VirtualHostRequestMatches(request, client.bucket) {
		client.capture.setConfigurationError("CLOUD_BACKUP_S3_VIRTUAL_HOST_INVALID", fmt.Sprintf("S3 virtualHost addressing requires request host to include bucket %q; SDK resolved %s; no request was sent", client.bucket, request.URL.Host))
		return nil, errors.New("CLOUD_BACKUP_S3_VIRTUAL_HOST_INVALID")
	}
	response, err := client.client.Do(request)
	if err != nil || response == nil {
		if err != nil {
			client.capture.setLocalError(request, "S3", err, client.secrets, upstreamEffectiveTimeout(45*time.Second, client.client))
		}
		return response, err
	}
	if response.StatusCode >= 400 {
		captured, body := cloudBackupProviderResponseAndBodyFromHTTPResponse(response, client.secrets)
		if response.Body != nil {
			response.Body.Close()
		}
		response.Body = io.NopCloser(strings.NewReader(body))
		client.capture.set(captured)
		return response, nil
	}
	if client.capture.operationValue() == "ListObjectsV2" && response.Body != nil {
		body, truncated, readErr := readS3ListResponseBody(response.Body)
		if readErr != nil {
			client.capture.setLocalErrorMessage("S3 ListObjectsV2 response could not be buffered: " + readErr.Error())
			return response, readErr
		}
		if truncated {
			client.capture.setLocalErrorMessage(fmt.Sprintf("S3 ListObjectsV2 response exceeded the %d-byte limit", cloudBackupS3ListResponseMaxBytes))
			response.Body = io.NopCloser(bytes.NewReader(body))
			return response, errors.New("CLOUD_BACKUP_S3_LIST_RESPONSE_TOO_LARGE")
		}
		response.Body = io.NopCloser(bytes.NewReader(body))
		if captured := cloudBackupProviderResponseFromBody(response, body, truncated, client.secrets); captured != nil {
			client.capture.set(captured)
		}
		if err := validateS3ListResponseBody(body); err != nil {
			return response, fmt.Errorf("invalid ListObjectsV2 XML: %w", err)
		}
	}
	return response, nil
}

func validateS3ListResponseBody(body []byte) error {
	decoder := xml.NewDecoder(bytes.NewReader(body))
	depth := 0
	rootSeen := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			if rootSeen && depth == 0 {
				return nil
			}
			return errors.New("missing ListBucketResult root")
		}
		if err != nil {
			return err
		}
		switch value := token.(type) {
		case xml.StartElement:
			if rootSeen && depth == 0 {
				return errors.New("multiple root elements")
			}
			if !rootSeen {
				if value.Name.Local != "ListBucketResult" {
					return fmt.Errorf("unexpected root element %q", value.Name.Local)
				}
				rootSeen = true
			}
			depth++
		case xml.EndElement:
			depth--
			if depth < 0 {
				return errors.New("unexpected closing element")
			}
		}
	}
}

func s3VirtualHostRequestMatches(request *http.Request, bucket string) bool {
	if request == nil || request.URL == nil {
		return false
	}
	host := strings.ToLower(request.URL.Hostname())
	bucket = strings.ToLower(strings.TrimSpace(bucket))
	return bucket != "" && (host == bucket || strings.HasPrefix(host, bucket+"."))
}

func readS3ListResponseBody(body io.ReadCloser) ([]byte, bool, error) {
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, cloudBackupS3ListResponseMaxBytes+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(data)) > cloudBackupS3ListResponseMaxBytes {
		return data[:cloudBackupS3ListResponseMaxBytes], true, nil
	}
	return data, false, nil
}

func (capture *s3ProviderResponseCapture) reset() {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	capture.response = nil
	capture.attemptedHost = ""
	capture.attemptedTarget = ""
	capture.localError = ""
	capture.localCode = ""
	capture.operation = ""
	capture.bucket = ""
	capture.key = ""
	capture.endpoint = ""
}

func (capture *s3ProviderResponseCapture) setOperation(operation string, endpoint string, bucket string, key string) {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	capture.operation = operation
	capture.endpoint = endpoint
	capture.bucket = bucket
	capture.key = key
}

func (capture *s3ProviderResponseCapture) operationValue() string {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	return capture.operation
}

func (capture *s3ProviderResponseCapture) attemptedTargetValue() string {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	return capture.attemptedTarget
}

func (capture *s3ProviderResponseCapture) set(response *cloudBackupProviderResponse) {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	capture.response = response
}

func (capture *s3ProviderResponseCapture) last() *cloudBackupProviderResponse {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	return capture.response
}

func (capture *s3ProviderResponseCapture) setAttemptedRequest(request *http.Request) {
	if request == nil || request.URL == nil {
		return
	}
	capture.mu.Lock()
	defer capture.mu.Unlock()
	capture.attemptedHost = request.URL.Scheme + "://" + request.URL.Host
	capture.attemptedTarget = capture.attemptedHost + request.URL.EscapedPath()
	if strings.TrimSpace(request.URL.EscapedPath()) == "" {
		capture.attemptedTarget += "/"
	}
}

func (capture *s3ProviderResponseCapture) setLocalErrorMessage(message string) {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	capture.localCode = ""
	capture.localError = strings.TrimSpace(message)
}

func (capture *s3ProviderResponseCapture) setConfigurationError(code string, message string) {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	capture.localCode = code
	capture.localError = strings.TrimSpace(message)
}

func (capture *s3ProviderResponseCapture) setLocalError(request *http.Request, provider string, err error, secrets []string, timeout time.Duration) {
	if request == nil {
		return
	}
	timedOut := upstreamNetErrorTimedOut(err) || errors.Is(request.Context().Err(), context.DeadlineExceeded)
	providerName := provider
	capture.mu.Lock()
	if capture.operation != "" {
		providerName += " " + capture.operation
	}
	capture.mu.Unlock()
	message := upstreamTransportDiagnosticMessage(request, upstreamHTTPRequestOptions{
		Provider: providerName,
		Timeout:  timeout,
		Secrets:  secrets,
	}, err, timeout, timedOut)
	capture.setLocalErrorMessage(message)
}

func (capture *s3ProviderResponseCapture) responseDetails(response *cloudBackupProviderResponse) *cloudBackupErrorDetails {
	return capture.responseDetailsWithClientMessage(response, "")
}

func (capture *s3ProviderResponseCapture) responseDetailsWithClientMessage(response *cloudBackupProviderResponse, clientMessage string) *cloudBackupErrorDetails {
	capture.mu.Lock()
	operation, endpoint, bucket, key, attemptedHost := capture.operation, capture.endpoint, capture.bucket, capture.key, capture.attemptedHost
	capture.mu.Unlock()
	target := "bucket=" + sanitizeCloudBackupTarget(bucket) + "; key=" + sanitizeCloudBackupTarget(cloudBackupObjectTargetKey(key))
	if host := firstNonBlankCloudBackupHost(attemptedHost, endpoint); host != "" {
		target = "host=" + host + "; " + target
	}
	return cloudBackupRemoteErrorDetails("s3", operation, sanitizeCloudBackupTarget(target), response, clientMessage)
}

func (capture *s3ProviderResponseCapture) localErrorValue() string {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	return capture.localError
}

func (capture *s3ProviderResponseCapture) describeLocalError(fallbackCode string, err error, secrets ...string) error {
	capture.mu.Lock()
	localError, localCode, operation, endpoint, bucket, key, attemptedHost := capture.localError, capture.localCode, capture.operation, capture.endpoint, capture.bucket, capture.key, capture.attemptedHost
	capture.mu.Unlock()
	target := "bucket=" + sanitizeCloudBackupTarget(bucket) + "; key=" + sanitizeCloudBackupTarget(cloudBackupObjectTargetKey(key))
	if host := firstNonBlankCloudBackupHost(attemptedHost, endpoint); host != "" {
		target = "host=" + host + "; " + target
	}
	if strings.TrimSpace(localError) != "" {
		if localCode == "" {
			localCode = fallbackCode
		}
		return &cloudBackupRemoteError{code: localCode, details: cloudBackupRemoteErrorDetails("s3", operation, sanitizeCloudBackupTarget(target), nil, localError)}
	}
	message := redactUpstreamSecrets(errorMessage(err), secrets)
	return &cloudBackupRemoteError{code: fallbackCode, details: cloudBackupRemoteErrorDetails("s3", operation, sanitizeCloudBackupTarget(target), nil, message)}
}

func cloudBackupObjectTargetKey(key string) string {
	key = strings.TrimSpace(key)
	if key == "" {
		return "(bucket root)"
	}
	return key
}

func firstNonBlankCloudBackupHost(attempted, endpoint string) string {
	if host := cloudBackupEndpointHost(attempted); host != "" {
		return host
	}
	return cloudBackupEndpointHost(endpoint)
}

func isS3NotFoundError(err error) bool {
	if err == nil {
		return false
	}
	remoteErr := cloudBackupRemoteErrorFrom(err)
	return remoteErr != nil && remoteErr.details != nil && remoteErr.details.HTTPStatus != nil && *remoteErr.details.HTTPStatus == http.StatusNotFound
}

func contentTypeForS3Key(key string) string {
	if strings.HasSuffix(key, ".manifest.json") {
		return "application/json"
	}
	if strings.HasSuffix(key, ".zip") {
		return "application/zip"
	}
	return "application/octet-stream"
}
