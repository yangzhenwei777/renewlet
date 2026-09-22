package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	systemUpdateDownloadMaxAttempts    = 3
	systemUpdateDownloadRetryBaseDelay = 500 * time.Millisecond
	systemUpdateDownloadRetryMaxDelay  = 5 * time.Second
	systemUpdateDownloadMaxRetryAfter  = 30 * time.Second
	systemUpdateDownloadBufferBytes    = 64 * 1024
	systemUpdateDownloadDateSafetyGap  = 60 * time.Second
	systemUpdateDownloadMaxDuration    = time.Duration(1<<63 - 1)
)

type systemReleaseDownloadPolicy struct {
	maxAttempts   int
	idleTimeout   time.Duration
	retryBase     time.Duration
	retryMax      time.Duration
	maxRetryAfter time.Duration
}

type systemReleaseDownloader struct {
	client *http.Client
	policy systemReleaseDownloadPolicy
	jitter func(time.Duration) time.Duration
	wait   func(context.Context, time.Duration) error
	now    func() time.Time
}

// systemReleaseDownloadState 保证文件长度、摘要和 offset 始终指向同一已确认前缀，validator 再把前缀绑定到同一上游对象。
type systemReleaseDownloadState struct {
	target       *os.File
	hash         hash.Hash
	offset       int64
	expectedSize int64
	validator    systemReleaseDownloadValidator
}

type systemReleaseDownloadValidator struct {
	header string
	value  string
}

// systemReleaseDownloadAttemptResult 只描述单次 HTTP 请求；重试预算、退避和最终失败统一由 Download 决定，避免多层重试放大请求。
type systemReleaseDownloadAttemptResult struct {
	complete   bool
	retryable  bool
	retryAfter *time.Duration
	err        error
}

type systemReleaseContentRange struct {
	start int64
	end   int64
	total int64
}

func defaultSystemReleaseDownloadHTTPClient() *http.Client {
	transport := defaultUpstreamHTTPTransport()
	transport.ResponseHeaderTimeout = systemUpdateDownloadHeaderTimeout
	// Client.Timeout 必须保持为零；响应体由无进展 watchdog 管理，总任务上限由 operation context 管理。
	return &http.Client{Transport: transport}
}

func newSystemReleaseDownloader(client *http.Client) *systemReleaseDownloader {
	return &systemReleaseDownloader{
		client: client,
		policy: systemReleaseDownloadPolicy{
			maxAttempts:   systemUpdateDownloadMaxAttempts,
			idleTimeout:   systemUpdateDownloadIdleTimeout,
			retryBase:     systemUpdateDownloadRetryBaseDelay,
			retryMax:      systemUpdateDownloadRetryMaxDelay,
			maxRetryAfter: systemUpdateDownloadMaxRetryAfter,
		},
		jitter: fullJitterDelay,
		wait:   waitForSystemReleaseRetry,
		now:    time.Now,
	}
}

// Download 在同一个临时文件和 SHA-256 状态上完成有限续传；只有带强 ETag 或有效 Last-Modified
// 的响应才允许拼接 Range，避免把不同 Release 对象组合成一个看似完整的归档。
func (downloader *systemReleaseDownloader) Download(
	ctx context.Context,
	sourceURL string,
	targetPath string,
	expectedSize int64,
	maxBytes int64,
) (_ string, resultErr error) {
	if downloader == nil || downloader.client == nil {
		return "", errors.New("system release download client is unavailable")
	}
	if maxBytes <= 0 || expectedSize < 0 || expectedSize > maxBytes {
		return "", errors.New("system release download size is invalid")
	}
	policy := downloader.normalizedPolicy()
	// 重试分片只存在于本次 operation 的 0600 临时文件；最终失败删除，成功 fsync 后才交给校验/安装阶段。
	target, err := os.OpenFile(targetPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	removePartial := true
	defer func() {
		_ = target.Close()
		if removePartial {
			_ = os.Remove(targetPath)
		}
	}()

	state := &systemReleaseDownloadState{
		target:       target,
		hash:         sha256.New(),
		expectedSize: expectedSize,
	}
	var lastErr error
	for attempt := 1; attempt <= policy.maxAttempts; attempt++ {
		if state.offset > 0 && state.validator.value == "" {
			// 没有 validator 时只能从头再取完整对象；checksum 是最终校验，不能代替 Range 的同对象证明。
			if err := state.reset(); err != nil {
				return "", err
			}
		}

		result := downloader.downloadAttempt(ctx, sourceURL, state, maxBytes, policy.idleTimeout)
		if result.complete {
			if err := target.Sync(); err != nil {
				return "", err
			}
			if err := target.Close(); err != nil {
				return "", err
			}
			removePartial = false
			return hex.EncodeToString(state.hash.Sum(nil)), nil
		}
		lastErr = result.err
		if !result.retryable || attempt == policy.maxAttempts {
			break
		}

		delay := downloader.retryDelay(attempt, policy)
		if result.retryAfter != nil {
			if *result.retryAfter > policy.maxRetryAfter {
				// 不能把上游要求的等待时间向下截断；超过本地任务容忍范围时直接失败，让用户稍后重新发起。
				break
			}
			delay = *result.retryAfter
		}
		if err := downloader.waitForRetry(ctx, delay); err != nil {
			return "", err
		}
	}
	if lastErr == nil {
		lastErr = errors.New("system release download failed")
	}
	return "", lastErr
}

func (downloader *systemReleaseDownloader) downloadAttempt(
	ctx context.Context,
	sourceURL string,
	state *systemReleaseDownloadState,
	maxBytes int64,
	idleTimeout time.Duration,
) systemReleaseDownloadAttemptResult {
	// 无进展 watchdog 只取消当前响应体读取；父 operation 仍可进入下一次尝试，并独立承担总任务上限。
	attemptCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	request, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, sourceURL, nil)
	if err != nil {
		return systemReleaseDownloadAttemptResult{err: err}
	}
	// Range 偏移、Content-Length 和发布 checksum 必须基于同一原始字节序列，禁止透明内容编码改变表示。
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", "Renewlet/"+Version)
	requestedOffset := state.offset
	if requestedOffset > 0 {
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-", requestedOffset))
		request.Header.Set("If-Range", state.validator.value)
	}

	response, requestErr := downloader.client.Do(request)
	if requestErr != nil {
		if ctx.Err() != nil {
			return systemReleaseDownloadAttemptResult{err: ctx.Err()}
		}
		timedOut := upstreamNetErrorTimedOut(requestErr)
		diagnostic := upstreamTransportDiagnosticMessage(request, upstreamHTTPRequestOptions{Provider: "GitHub Release archive"}, requestErr, systemUpdateDownloadHeaderTimeout, timedOut)
		return systemReleaseDownloadAttemptResult{
			retryable: retryableSystemReleaseTransportError(requestErr),
			err:       newUpstreamTransportError(diagnostic, timedOut),
		}
	}
	if response == nil || response.Body == nil {
		message := "GitHub Release archive response body is empty"
		return systemReleaseDownloadAttemptResult{err: newUpstreamTransportError(message, false)}
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent {
		providerResponse := upstreamProviderResponseFromBody(response, "", false, nil)
		responseErr := createUpstreamHTTPError("GitHub Release archive", response, providerResponse, upstreamProviderMessage(providerResponse))
		retryable := retryableSystemReleaseStatus(response.StatusCode)
		var retryAfter *time.Duration
		if retryable {
			retryAfter = parseSystemReleaseRetryAfter(response.Header.Get("Retry-After"), downloader.currentTime())
		}
		return systemReleaseDownloadAttemptResult{retryable: retryable, retryAfter: retryAfter, err: responseErr}
	}
	if encoding := strings.TrimSpace(response.Header.Get("Content-Encoding")); encoding != "" && !strings.EqualFold(encoding, "identity") {
		return systemReleaseDownloadAttemptResult{err: fmt.Errorf("unexpected system release content encoding %q", encoding)}
	}
	if err := prepareSystemReleaseDownloadResponse(response, state, requestedOffset, maxBytes); err != nil {
		return systemReleaseDownloadAttemptResult{err: err}
	}
	return readSystemReleaseDownloadBody(ctx, cancel, response.Body, state, maxBytes, idleTimeout)
}

func prepareSystemReleaseDownloadResponse(response *http.Response, state *systemReleaseDownloadState, requestedOffset int64, maxBytes int64) error {
	switch response.StatusCode {
	case http.StatusOK:
		if requestedOffset > 0 {
			// If-Range 未命中或上游忽略 Range 时会回落到 200；必须清空旧片段和 hash，禁止重复拼接。
			if err := state.reset(); err != nil {
				return err
			}
		}
		if response.ContentLength >= 0 {
			if err := state.acceptExpectedSize(response.ContentLength, maxBytes); err != nil {
				return err
			}
		}
		state.validator = systemReleaseDownloadValidatorFromHeaders(response.Header)
		return nil
	case http.StatusPartialContent:
		if requestedOffset <= 0 || state.validator.value == "" {
			return errors.New("unexpected partial system release response")
		}
		contentRange, err := parseSystemReleaseContentRange(response.Header.Get("Content-Range"))
		if err != nil {
			return err
		}
		if contentRange.start != requestedOffset {
			return fmt.Errorf("system release Content-Range starts at %d, want %d", contentRange.start, requestedOffset)
		}
		if response.ContentLength >= 0 && response.ContentLength != contentRange.end-contentRange.start+1 {
			return errors.New("system release Content-Length does not match Content-Range")
		}
		if err := state.acceptExpectedSize(contentRange.total, maxBytes); err != nil {
			return err
		}
		// If-Range 命中后的 206 已证明对象未变；上游可以不回显 validator，但一旦回显就必须与首段完全一致。
		if value := strings.TrimSpace(response.Header.Get(state.validator.header)); value != "" && value != state.validator.value {
			return errors.New("system release validator changed during Range download")
		}
		return nil
	default:
		return fmt.Errorf("unexpected system release status %d", response.StatusCode)
	}
}

func readSystemReleaseDownloadBody(
	ctx context.Context,
	cancel context.CancelFunc,
	body io.Reader,
	state *systemReleaseDownloadState,
	maxBytes int64,
	idleTimeout time.Duration,
) systemReleaseDownloadAttemptResult {
	buffer := make([]byte, systemUpdateDownloadBufferBytes)
	for {
		// 每次成功 Read 都重新开始计时，因此低带宽但持续有进展的下载不会被总响应体超时误杀。
		readBytes, readErr, stalled := readSystemReleaseDownloadChunk(body, buffer, idleTimeout, cancel)
		if readBytes > 0 {
			if int64(readBytes) > maxBytes-state.offset {
				return systemReleaseDownloadAttemptResult{err: errors.New("system release download exceeds size limit")}
			}
			if state.expectedSize > 0 && int64(readBytes) > state.expectedSize-state.offset {
				return systemReleaseDownloadAttemptResult{err: errors.New("system release download exceeds expected size")}
			}
			if err := state.write(buffer[:readBytes]); err != nil {
				return systemReleaseDownloadAttemptResult{err: err}
			}
		}
		if stalled {
			message := fmt.Sprintf("GitHub Release archive download made no progress for %s after %d bytes", upstreamDurationText(idleTimeout), state.offset)
			return systemReleaseDownloadAttemptResult{retryable: true, err: newUpstreamTransportError(message, true)}
		}
		if readErr == nil {
			if readBytes == 0 {
				message := fmt.Sprintf("GitHub Release archive download made no progress after %d bytes", state.offset)
				return systemReleaseDownloadAttemptResult{retryable: true, err: newUpstreamTransportError(message, true)}
			}
			continue
		}
		if errors.Is(readErr, io.EOF) {
			if state.expectedSize > 0 && state.offset != state.expectedSize {
				message := fmt.Sprintf("GitHub Release archive download ended after %d of %d bytes", state.offset, state.expectedSize)
				return systemReleaseDownloadAttemptResult{retryable: true, err: newUpstreamTransportError(message, false)}
			}
			if state.expectedSize == 0 {
				state.expectedSize = state.offset
			}
			return systemReleaseDownloadAttemptResult{complete: true}
		}
		if ctx.Err() != nil {
			return systemReleaseDownloadAttemptResult{err: ctx.Err()}
		}
		if retryableSystemReleaseBodyError(readErr) {
			message := fmt.Sprintf("GitHub Release archive download interrupted after %d bytes: %s", state.offset, redactedUpstreamTransportError(readErr, nil))
			return systemReleaseDownloadAttemptResult{
				retryable: true,
				err:       newUpstreamTransportError(message, upstreamNetErrorTimedOut(readErr)),
			}
		}
		return systemReleaseDownloadAttemptResult{err: readErr}
	}
}

func readSystemReleaseDownloadChunk(body io.Reader, buffer []byte, idleTimeout time.Duration, cancel context.CancelFunc) (int, error, bool) {
	if idleTimeout <= 0 {
		readBytes, err := body.Read(buffer)
		return readBytes, err, false
	}
	var stalled atomic.Bool
	fired := make(chan struct{})
	timer := time.AfterFunc(idleTimeout, func() {
		stalled.Store(true)
		cancel()
		close(fired)
	})
	readBytes, err := body.Read(buffer)
	if !timer.Stop() {
		// Stop=false 时回调可能仍在运行；等它结束再返回，避免迟到的 cancel 污染下一次 Read 的判定。
		<-fired
	}
	return readBytes, err, stalled.Load()
}

func (state *systemReleaseDownloadState) reset() error {
	// 续传回落必须把文件、摘要、offset 和 validator 一起归零，任何一项残留都会让最终 checksum 失真。
	if err := state.target.Truncate(0); err != nil {
		return err
	}
	if _, err := state.target.Seek(0, io.SeekStart); err != nil {
		return err
	}
	state.hash.Reset()
	state.offset = 0
	state.validator = systemReleaseDownloadValidator{}
	return nil
}

func (state *systemReleaseDownloadState) write(data []byte) error {
	// 只有文件完整写入且摘要接收同一块数据后才提交 offset，下一次 Range 不能越过未纳入校验的字节。
	written, err := state.target.Write(data)
	if err != nil {
		return err
	}
	if written != len(data) {
		return io.ErrShortWrite
	}
	if _, err := state.hash.Write(data); err != nil {
		return err
	}
	state.offset += int64(written)
	return nil
}

func (state *systemReleaseDownloadState) acceptExpectedSize(size int64, maxBytes int64) error {
	if size < 0 || size > maxBytes {
		return errors.New("system release download exceeds size limit")
	}
	if state.expectedSize > 0 && state.expectedSize != size {
		return fmt.Errorf("system release size changed from %d to %d", state.expectedSize, size)
	}
	state.expectedSize = size
	return nil
}

func systemReleaseDownloadValidatorFromHeaders(headers http.Header) systemReleaseDownloadValidator {
	etag := strings.TrimSpace(headers.Get("ETag"))
	if etag != "" {
		if strings.HasPrefix(etag, "\"") && strings.HasSuffix(etag, "\"") && !strings.HasPrefix(strings.ToUpper(etag), "W/") {
			return systemReleaseDownloadValidator{header: "ETag", value: etag}
		}
		// If-Range 禁止弱 ETag；响应已经给出 entity-tag 时也不能改用日期绕过强比较。
		return systemReleaseDownloadValidator{}
	}
	lastModified := strings.TrimSpace(headers.Get("Last-Modified"))
	lastModifiedAt, lastModifiedErr := http.ParseTime(lastModified)
	responseAt, responseDateErr := http.ParseTime(strings.TrimSpace(headers.Get("Date")))
	// HTTP-date 默认是弱 validator；仅在同一响应的 Date 明显更晚时才允许 If-Range，给时钟误差留出保守余量。
	if lastModifiedErr == nil && responseDateErr == nil && responseAt.Sub(lastModifiedAt) >= systemUpdateDownloadDateSafetyGap {
		return systemReleaseDownloadValidator{header: "Last-Modified", value: lastModified}
	}
	return systemReleaseDownloadValidator{}
}

func parseSystemReleaseContentRange(value string) (systemReleaseContentRange, error) {
	unit, interval, ok := strings.Cut(strings.TrimSpace(value), " ")
	if !ok || unit != "bytes" {
		return systemReleaseContentRange{}, errors.New("invalid system release Content-Range unit")
	}
	rangeText, totalText, ok := strings.Cut(interval, "/")
	if !ok || totalText == "*" {
		return systemReleaseContentRange{}, errors.New("invalid system release Content-Range total")
	}
	startText, endText, ok := strings.Cut(rangeText, "-")
	if !ok {
		return systemReleaseContentRange{}, errors.New("invalid system release Content-Range interval")
	}
	start, startErr := strconv.ParseInt(startText, 10, 64)
	end, endErr := strconv.ParseInt(endText, 10, 64)
	total, totalErr := strconv.ParseInt(totalText, 10, 64)
	if startErr != nil || endErr != nil || totalErr != nil || start < 0 || end < start || total <= end {
		return systemReleaseContentRange{}, errors.New("invalid system release Content-Range values")
	}
	return systemReleaseContentRange{start: start, end: end, total: total}, nil
}

func retryableSystemReleaseStatus(status int) bool {
	switch status {
	case http.StatusRequestTimeout,
		http.StatusTooManyRequests,
		http.StatusInternalServerError,
		http.StatusBadGateway,
		http.StatusServiceUnavailable,
		http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

func retryableSystemReleaseTransportError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return false
	}
	if systemReleaseCertificateError(err) {
		// 证书链、主机名或 TLS 记录错误不是通过重复同一请求能修复的瞬态故障，必须立即暴露给管理员。
		return false
	}
	var netErr net.Error
	if errors.As(err, &netErr) && (netErr.Timeout() || netErr.Temporary()) {
		return true
	}
	return errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.EPIPE)
}

func retryableSystemReleaseBodyError(err error) bool {
	return errors.Is(err, io.ErrUnexpectedEOF) || retryableSystemReleaseTransportError(err)
}

func systemReleaseCertificateError(err error) bool {
	var verificationErr *tls.CertificateVerificationError
	var hostnameErr x509.HostnameError
	var authorityErr x509.UnknownAuthorityError
	var certificateErr x509.CertificateInvalidError
	var recordHeaderErr tls.RecordHeaderError
	return errors.As(err, &verificationErr) ||
		errors.As(err, &hostnameErr) ||
		errors.As(err, &authorityErr) ||
		errors.As(err, &certificateErr) ||
		errors.As(err, &recordHeaderErr)
}

func parseSystemReleaseRetryAfter(value string, now time.Time) *time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil && seconds >= 0 {
		if seconds > int64(systemUpdateDownloadMaxDuration/time.Second) {
			delay := systemUpdateDownloadMaxDuration
			return &delay
		}
		delay := time.Duration(seconds) * time.Second
		return &delay
	}
	if retryAt, err := http.ParseTime(value); err == nil {
		delay := retryAt.Sub(now)
		if delay < 0 {
			delay = 0
		}
		return &delay
	}
	return nil
}

func (downloader *systemReleaseDownloader) normalizedPolicy() systemReleaseDownloadPolicy {
	policy := downloader.policy
	if policy.maxAttempts <= 0 {
		policy.maxAttempts = systemUpdateDownloadMaxAttempts
	}
	if policy.idleTimeout <= 0 {
		policy.idleTimeout = systemUpdateDownloadIdleTimeout
	}
	if policy.retryBase <= 0 {
		policy.retryBase = systemUpdateDownloadRetryBaseDelay
	}
	if policy.retryMax < policy.retryBase {
		policy.retryMax = systemUpdateDownloadRetryMaxDelay
	}
	if policy.maxRetryAfter <= 0 {
		policy.maxRetryAfter = systemUpdateDownloadMaxRetryAfter
	}
	return policy
}

func (downloader *systemReleaseDownloader) retryDelay(attempt int, policy systemReleaseDownloadPolicy) time.Duration {
	maximum := policy.retryBase
	for index := 1; index < attempt && maximum < policy.retryMax; index++ {
		maximum *= 2
		if maximum > policy.retryMax {
			maximum = policy.retryMax
		}
	}
	// full jitter 在 [0, capped exponential delay] 内分散重试，避免多个实例在 GitHub 恢复时同步冲击上游。
	if downloader.jitter == nil {
		return fullJitterDelay(maximum)
	}
	return downloader.jitter(maximum)
}

func (downloader *systemReleaseDownloader) waitForRetry(ctx context.Context, delay time.Duration) error {
	if downloader.wait == nil {
		return waitForSystemReleaseRetry(ctx, delay)
	}
	return downloader.wait(ctx, delay)
}

func (downloader *systemReleaseDownloader) currentTime() time.Time {
	if downloader.now == nil {
		return time.Now()
	}
	return downloader.now()
}

func fullJitterDelay(maximum time.Duration) time.Duration {
	if maximum <= 0 {
		return 0
	}
	if maximum == systemUpdateDownloadMaxDuration {
		return time.Duration(rand.Int64())
	}
	return time.Duration(rand.Int64N(int64(maximum) + 1))
}

func waitForSystemReleaseRetry(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
