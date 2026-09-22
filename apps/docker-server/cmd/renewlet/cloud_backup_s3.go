package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type s3CloudBackupClient struct {
	settings cloudBackupS3Settings
	secret   string
	client   *s3.Client
	capture  *s3ProviderResponseCapture
}

type s3ProviderResponseCapture struct {
	mu            sync.Mutex
	response      *cloudBackupProviderResponse
	attemptedHost string
	localError    string
}

type s3CaptureHTTPClient struct {
	client  *http.Client
	capture *s3ProviderResponseCapture
	secrets []string
}

func newS3CloudBackupClient(settings cloudBackupS3Settings, secret string) *s3CloudBackupClient {
	capture := &s3ProviderResponseCapture{}
	// AWS SDK 负责签名和协议序列化；custom HTTP client 只把 S3 外发纳入统一超时、代理和脱敏错误边界。
	httpClient := &s3CaptureHTTPClient{
		client:  defaultUpstreamHTTPClient(45 * time.Second),
		capture: capture,
		secrets: []string{settings.AccessKeyID, secret},
	}
	return &s3CloudBackupClient{
		settings: settings,
		secret:   secret,
		client:   newS3SDKClient(settings, secret, httpClient),
		capture:  capture,
	}
}

func newS3SDKClient(settings cloudBackupS3Settings, secret string, httpClient aws.HTTPClient) *s3.Client {
	endpointMode := resolveCloudBackupS3EndpointMode(settings)
	return s3.NewFromConfig(aws.Config{
		Region:                     settings.Region,
		Credentials:                aws.NewCredentialsCache(credentials.NewStaticCredentialsProvider(settings.AccessKeyID, secret, "")),
		HTTPClient:                 httpClient,
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
	}, func(options *s3.Options) {
		options.BaseEndpoint = aws.String(settings.Endpoint)
		options.UsePathStyle = endpointMode == cloudBackupS3PathStyleEndpoint
		options.RetryMaxAttempts = 1
	})
}

func (client *s3CloudBackupClient) Test(ctx context.Context) error {
	name := client.key(".renewlet-probe-" + randomHex(4) + ".txt")
	content := []byte("renewlet-cloud-backup-probe")
	if err := client.putObject(ctx, name, content); err != nil {
		return err
	}
	defer func() { _ = client.deleteObject(ctx, name) }()
	if size, err := client.headObject(ctx, name); err != nil || (size >= 0 && size != int64(len(content))) {
		if err != nil {
			return err
		}
		return errors.New("CLOUD_BACKUP_S3_PROBE_MISMATCH")
	}
	got, err := client.getObject(ctx, name)
	if err != nil {
		return err
	}
	if !bytes.Equal(got, content) {
		return errors.New("CLOUD_BACKUP_S3_PROBE_MISMATCH")
	}
	if err := client.deleteObject(ctx, name); err != nil {
		return err
	}
	// 测试连接必须覆盖 ListBucket 权限和地址模式；只 PUT/GET 探针会漏掉 COS/R2 列表失败。
	_, err = client.listObjects(ctx, client.key(""))
	return err
}

func (client *s3CloudBackupClient) List(ctx context.Context) ([]cloudBackupSnapshotManifest, error) {
	keys, err := client.listObjects(ctx, client.key(""))
	if err != nil {
		return nil, err
	}
	manifests := []cloudBackupSnapshotManifest{}
	for _, key := range keys {
		if !strings.HasSuffix(key, ".manifest.json") {
			continue
		}
		data, err := client.getObject(ctx, key)
		if err != nil {
			continue
		}
		var manifest cloudBackupSnapshotManifest
		if err := json.Unmarshal(data, &manifest); err == nil && manifest.ID != "" {
			manifests = append(manifests, manifest)
		}
	}
	return manifests, nil
}

func (client *s3CloudBackupClient) Upload(ctx context.Context, filename string, source cloudBackupSnapshotSource, manifest cloudBackupSnapshotManifest) error {
	key := client.key(filename)
	if err := client.putObjectSource(ctx, key, source); err != nil {
		return err
	}
	if size, err := client.headObject(ctx, key); err != nil || (size >= 0 && size != source.Size()) {
		if err != nil {
			return err
		}
		return errors.New("CLOUD_BACKUP_S3_HEAD_MISMATCH")
	}
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	return client.putObject(ctx, client.key(manifestNameForSnapshotID(manifest.ID)), manifestBytes)
}

func (client *s3CloudBackupClient) putObjectSource(ctx context.Context, key string, source cloudBackupSnapshotSource) error {
	reader, err := source.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	return client.captureS3Error("CLOUD_BACKUP_S3_PUT_FAILED", func() error {
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
		return nil, cloudBackupSnapshotManifest{}, err
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
	prefix := strings.Trim(client.settings.Prefix, "/")
	filename = strings.Trim(filename, "/")
	if prefix == "" {
		return filename
	}
	if filename == "" {
		return prefix + "/"
	}
	return prefix + "/" + filename
}

type cloudBackupS3EndpointMode string

const (
	cloudBackupS3ServiceEndpoint   cloudBackupS3EndpointMode = "serviceEndpoint"
	cloudBackupS3PathStyleEndpoint cloudBackupS3EndpointMode = "pathStyleEndpoint"
)

func resolveCloudBackupS3EndpointMode(settings cloudBackupS3Settings) cloudBackupS3EndpointMode {
	parsed, err := url.Parse(settings.Endpoint)
	if err != nil {
		return cloudBackupS3ServiceEndpoint
	}
	hostname := strings.ToLower(strings.Trim(parsed.Hostname(), "[]"))
	if cloudBackupS3UsePathStyle(parsed, hostname) {
		return cloudBackupS3PathStyleEndpoint
	}
	return cloudBackupS3ServiceEndpoint
}

func cloudBackupS3UsePathStyle(parsed *url.URL, hostname string) bool {
	port := parsed.Port()
	// S3 兼容服务没有统一供应商发现协议；这里只根据客观网络形态决定 path-style，不按域名猜服务商或 bucket 绑定。
	if port != "" && port != "443" {
		return true
	}
	if hostname == "localhost" || strings.HasSuffix(hostname, ".localhost") || strings.HasSuffix(hostname, ".local") {
		return true
	}
	return net.ParseIP(hostname) != nil
}

func (client *s3CloudBackupClient) listObjects(ctx context.Context, prefix string) ([]string, error) {
	const pageSize int32 = 1000
	paginator := s3.NewListObjectsV2Paginator(client.client, &s3.ListObjectsV2Input{
		Bucket:  aws.String(client.settings.Bucket),
		Prefix:  aws.String(prefix),
		MaxKeys: aws.Int32(pageSize),
	})
	keys := []string{}
	for paginator.HasMorePages() {
		var page *s3.ListObjectsV2Output
		err := client.captureS3Error("CLOUD_BACKUP_S3_LIST_FAILED", func() error {
			var err error
			page, err = paginator.NextPage(ctx)
			return err
		})
		if err != nil {
			return nil, err
		}
		for _, item := range page.Contents {
			if item.Key != nil {
				keys = append(keys, *item.Key)
			}
		}
	}
	return keys, nil
}

func (client *s3CloudBackupClient) putObject(ctx context.Context, key string, content []byte) error {
	return client.captureS3Error("CLOUD_BACKUP_S3_PUT_FAILED", func() error {
		_, err := client.client.PutObject(ctx, &s3.PutObjectInput{
			Bucket:      aws.String(client.settings.Bucket),
			Key:         aws.String(key),
			Body:        bytes.NewReader(content),
			ContentType: aws.String(contentTypeForS3Key(key)),
		})
		return err
	})
}

func (client *s3CloudBackupClient) getObject(ctx context.Context, key string) ([]byte, error) {
	var output *s3.GetObjectOutput
	err := client.captureS3Error("CLOUD_BACKUP_S3_GET_FAILED", func() error {
		var err error
		output, err = client.client.GetObject(ctx, &s3.GetObjectInput{
			Bucket: aws.String(client.settings.Bucket),
			Key:    aws.String(key),
		})
		return err
	})
	if err != nil {
		return nil, err
	}
	defer output.Body.Close()
	data, err := io.ReadAll(io.LimitReader(output.Body, cloudBackupSnapshotMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > cloudBackupSnapshotMaxBytes {
		return nil, errors.New("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE")
	}
	return data, nil
}

func (client *s3CloudBackupClient) headObject(ctx context.Context, key string) (int64, error) {
	var output *s3.HeadObjectOutput
	err := client.captureS3Error("CLOUD_BACKUP_S3_HEAD_FAILED", func() error {
		var err error
		output, err = client.client.HeadObject(ctx, &s3.HeadObjectInput{
			Bucket: aws.String(client.settings.Bucket),
			Key:    aws.String(key),
		})
		return err
	})
	if err != nil {
		return 0, err
	}
	if output.ContentLength == nil {
		return -1, nil
	}
	return *output.ContentLength, nil
}

func (client *s3CloudBackupClient) deleteObject(ctx context.Context, key string) error {
	err := client.captureS3Error("CLOUD_BACKUP_S3_DELETE_FAILED", func() error {
		_, err := client.client.DeleteObject(ctx, &s3.DeleteObjectInput{
			Bucket: aws.String(client.settings.Bucket),
			Key:    aws.String(key),
		})
		return err
	})
	if isS3NotFoundError(err) {
		return nil
	}
	return err
}

func (client *s3CloudBackupClient) captureS3Error(code string, operation func() error) error {
	client.capture.reset()
	if err := operation(); err != nil {
		if response := client.capture.last(); response != nil {
			return cloudBackupRemoteHTTPErrorFromProviderResponse(s3ErrorCodeForStatus(code, response), response)
		}
		return client.capture.describeLocalError(err)
	}
	return nil
}

func (client *s3CaptureHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.capture.setAttemptedRequest(request)
	response, err := client.client.Do(request)
	if err != nil || response == nil {
		if err != nil {
			client.capture.setLocalError(request, "S3", err, client.secrets, upstreamEffectiveTimeout(45*time.Second, client.client))
		}
		return response, err
	}
	if response.StatusCode < 400 {
		return response, nil
	}
	// SDK 还要继续反序列化错误响应；这里重放 body，同时只捕获脱敏后的上游 status/header/body 给当前请求。
	captured, body := cloudBackupProviderResponseAndBodyFromHTTPResponse(response, client.secrets)
	response.Body.Close()
	response.Body = io.NopCloser(strings.NewReader(body))
	client.capture.set(captured)
	return response, nil
}

func (capture *s3ProviderResponseCapture) reset() {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	capture.response = nil
	capture.attemptedHost = ""
	capture.localError = ""
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
}

func (capture *s3ProviderResponseCapture) attemptedHostValue() string {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	return capture.attemptedHost
}

func (capture *s3ProviderResponseCapture) setLocalError(request *http.Request, provider string, err error, secrets []string, timeout time.Duration) {
	if request == nil {
		return
	}
	timedOut := upstreamNetErrorTimedOut(err) || errors.Is(request.Context().Err(), context.DeadlineExceeded)
	// 本地 DNS/TLS/代理错误没有 HTTP body；仍用同一 redacted request context，避免 attempted URL 或签名 query 原样泄露。
	message := upstreamTransportDiagnosticMessage(request, upstreamHTTPRequestOptions{
		Provider: provider,
		Timeout:  timeout,
		Secrets:  secrets,
	}, err, timeout, timedOut)
	capture.mu.Lock()
	defer capture.mu.Unlock()
	capture.localError = message
}

func (capture *s3ProviderResponseCapture) describeLocalError(err error) error {
	capture.mu.Lock()
	localError := capture.localError
	capture.mu.Unlock()
	if strings.TrimSpace(localError) != "" {
		return &cloudBackupRemoteError{
			code:    "CLOUD_BACKUP_S3_LOCAL_FAILED",
			details: &cloudBackupErrorDetails{RawResponseText: optionalCloudBackupString(localError)},
		}
	}
	attemptedHost := capture.attemptedHostValue()
	var wrapped error
	if err == nil {
		wrapped = errors.New("CLOUD_BACKUP_S3_LOCAL_FAILED")
	} else if attemptedHost == "" {
		wrapped = err
	} else {
		wrapped = errors.New(err.Error() + " (attempted host: " + attemptedHost + ")")
	}
	return &cloudBackupRemoteError{
		code:    "CLOUD_BACKUP_S3_LOCAL_FAILED",
		details: cloudBackupLocalErrorDetails(wrapped),
	}
}

func s3ErrorCodeForStatus(fallback string, response *cloudBackupProviderResponse) string {
	if response != nil && response.Status != nil && *response.Status == http.StatusNotFound {
		return "CLOUD_BACKUP_S3_NOT_FOUND"
	}
	return fallback
}

func isS3NotFoundError(err error) bool {
	if err == nil {
		return false
	}
	remoteErr := cloudBackupRemoteErrorFrom(err)
	return remoteErr != nil && remoteErr.code == "CLOUD_BACKUP_S3_NOT_FOUND"
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
