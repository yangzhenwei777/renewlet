package main

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDefaultSystemReleaseDownloaderSeparatesArchiveTimeouts(t *testing.T) {
	client, ok := defaultSystemReleaseClient().(*httpSystemReleaseClient)
	if !ok {
		t.Fatal("default release client is not HTTP-backed")
	}
	if client.metadataClient.Timeout != systemUpdateCheckTimeout {
		t.Fatalf("metadata timeout = %s, want %s", client.metadataClient.Timeout, systemUpdateCheckTimeout)
	}
	if client.assetClient.Timeout != systemUpdateAssetRequestTimeout {
		t.Fatalf("asset timeout = %s, want %s", client.assetClient.Timeout, systemUpdateAssetRequestTimeout)
	}
	if client.downloader == nil || client.downloader.client == nil {
		t.Fatal("archive downloader is unavailable")
	}
	if client.downloader.client.Timeout != 0 {
		t.Fatalf("archive client timeout = %s, want no response-body timeout", client.downloader.client.Timeout)
	}
	transport, ok := client.downloader.client.Transport.(*http.Transport)
	if !ok {
		t.Fatal("archive client transport is not *http.Transport")
	}
	if transport.ResponseHeaderTimeout != systemUpdateDownloadHeaderTimeout {
		t.Fatalf("archive header timeout = %s, want %s", transport.ResponseHeaderTimeout, systemUpdateDownloadHeaderTimeout)
	}
}

func TestSystemReleaseDownloaderTimesOutWaitingForHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		time.Sleep(50 * time.Millisecond)
		response.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	transport := defaultUpstreamHTTPTransport()
	transport.ResponseHeaderTimeout = 10 * time.Millisecond
	downloader := newTestSystemReleaseDownloader(transport)
	downloader.policy.maxAttempts = 1
	targetPath := filepath.Join(t.TempDir(), "archive.tar.gz")
	_, err := downloader.Download(context.Background(), server.URL, targetPath, 0, 16)
	if err == nil || !upstreamOperationTimedOut(err) {
		t.Fatalf("header timeout error = %v", err)
	}
}

func TestSystemReleaseDownloaderAllowsSlowProgress(t *testing.T) {
	content := []byte(strings.Repeat("x", 50))
	var attempts atomic.Int32
	downloader := newTestSystemReleaseDownloader(roundTripFunc(func(request *http.Request) (*http.Response, error) {
		attempts.Add(1)
		return systemReleaseDownloadResponse(request, http.StatusOK, &delayedByteReadCloser{
			data:  content,
			delay: 5 * time.Millisecond,
		}, int64(len(content)), http.Header{"ETag": []string{`"slow"`}}), nil
	}))
	downloader.policy.idleTimeout = 200 * time.Millisecond

	targetPath, checksum, err := downloadSystemReleaseForTest(t, downloader, int64(len(content)), int64(len(content)))
	if err != nil {
		t.Fatal(err)
	}
	assertSystemReleaseDownload(t, targetPath, content, checksum)
	if attempts.Load() != 1 {
		t.Fatalf("attempts = %d, want 1", attempts.Load())
	}
}

func TestSystemReleaseDownloaderResumesAfterIdleTimeout(t *testing.T) {
	content := []byte("abcdef")
	var attempts atomic.Int32
	downloader := newTestSystemReleaseDownloader(roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch attempts.Add(1) {
		case 1:
			return systemReleaseDownloadResponse(request, http.StatusOK, &partialThenContextReadCloser{
				data: []byte("abc"),
				ctx:  request.Context(),
			}, int64(len(content)), http.Header{"ETag": []string{`"archive-v1"`}}), nil
		case 2:
			if request.Header.Get("Range") != "bytes=3-" || request.Header.Get("If-Range") != `"archive-v1"` {
				t.Fatalf("resume headers = %#v", request.Header)
			}
			return systemReleaseDownloadResponse(request, http.StatusPartialContent, io.NopCloser(strings.NewReader("def")), 3, http.Header{
				"Content-Range": []string{"bytes 3-5/6"},
				"ETag":          []string{`"archive-v1"`},
			}), nil
		default:
			t.Fatalf("unexpected attempt %d", attempts.Load())
			return nil, errors.New("unexpected attempt")
		}
	}))
	downloader.policy.idleTimeout = 15 * time.Millisecond

	targetPath, checksum, err := downloadSystemReleaseForTest(t, downloader, int64(len(content)), int64(len(content)))
	if err != nil {
		t.Fatal(err)
	}
	assertSystemReleaseDownload(t, targetPath, content, checksum)
	if attempts.Load() != 2 {
		t.Fatalf("attempts = %d, want 2", attempts.Load())
	}
}

func TestSystemReleaseDownloaderRestartsWhenRangeIsIgnored(t *testing.T) {
	content := []byte("abcdef")
	var attempts atomic.Int32
	downloader := newTestSystemReleaseDownloader(roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch attempts.Add(1) {
		case 1:
			return systemReleaseDownloadResponse(request, http.StatusOK, &singleReadErrorCloser{data: []byte("abc"), err: io.ErrUnexpectedEOF}, int64(len(content)), http.Header{
				"ETag": []string{`"archive-v1"`},
			}), nil
		case 2:
			if request.Header.Get("Range") != "bytes=3-" || request.Header.Get("If-Range") != `"archive-v1"` {
				t.Fatalf("resume headers = %#v", request.Header)
			}
			return systemReleaseDownloadResponse(request, http.StatusOK, io.NopCloser(strings.NewReader(string(content))), int64(len(content)), http.Header{
				"ETag": []string{`"archive-v1"`},
			}), nil
		default:
			t.Fatalf("unexpected attempt %d", attempts.Load())
			return nil, errors.New("unexpected attempt")
		}
	}))

	targetPath, checksum, err := downloadSystemReleaseForTest(t, downloader, int64(len(content)), int64(len(content)))
	if err != nil {
		t.Fatal(err)
	}
	assertSystemReleaseDownload(t, targetPath, content, checksum)
}

func TestSystemReleaseDownloaderRestartsWithoutValidator(t *testing.T) {
	content := []byte("abcdef")
	var attempts atomic.Int32
	downloader := newTestSystemReleaseDownloader(roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch attempts.Add(1) {
		case 1:
			return systemReleaseDownloadResponse(request, http.StatusOK, &singleReadErrorCloser{data: []byte("abc"), err: io.ErrUnexpectedEOF}, int64(len(content)), nil), nil
		case 2:
			if request.Header.Get("Range") != "" || request.Header.Get("If-Range") != "" {
				t.Fatalf("unsafe resume headers = %#v", request.Header)
			}
			return systemReleaseDownloadResponse(request, http.StatusOK, io.NopCloser(strings.NewReader(string(content))), int64(len(content)), nil), nil
		default:
			t.Fatalf("unexpected attempt %d", attempts.Load())
			return nil, errors.New("unexpected attempt")
		}
	}))

	targetPath, checksum, err := downloadSystemReleaseForTest(t, downloader, int64(len(content)), int64(len(content)))
	if err != nil {
		t.Fatal(err)
	}
	assertSystemReleaseDownload(t, targetPath, content, checksum)
}

func TestSystemReleaseDownloadValidatorRequiresStrongEvidence(t *testing.T) {
	responseAt := time.Date(2026, time.August, 24, 12, 0, 0, 0, time.UTC)
	oldModifiedAt := responseAt.Add(-2 * systemUpdateDownloadDateSafetyGap)
	recentModifiedAt := responseAt.Add(-systemUpdateDownloadDateSafetyGap + time.Second)
	tests := []struct {
		name    string
		headers http.Header
		want    systemReleaseDownloadValidator
	}{
		{
			name:    "strong etag",
			headers: http.Header{"ETag": []string{`"archive-v1"`}},
			want:    systemReleaseDownloadValidator{header: "ETag", value: `"archive-v1"`},
		},
		{
			name: "weak etag cannot fall back to date",
			headers: http.Header{
				"ETag":          []string{`W/"archive-v1"`},
				"Date":          []string{responseAt.Format(http.TimeFormat)},
				"Last-Modified": []string{oldModifiedAt.Format(http.TimeFormat)},
			},
		},
		{
			name:    "last modified without response date",
			headers: http.Header{"Last-Modified": []string{oldModifiedAt.Format(http.TimeFormat)}},
		},
		{
			name: "last modified inside safety gap",
			headers: http.Header{
				"Date":          []string{responseAt.Format(http.TimeFormat)},
				"Last-Modified": []string{recentModifiedAt.Format(http.TimeFormat)},
			},
		},
		{
			name: "last modified outside safety gap",
			headers: http.Header{
				"Date":          []string{responseAt.Format(http.TimeFormat)},
				"Last-Modified": []string{oldModifiedAt.Format(http.TimeFormat)},
			},
			want: systemReleaseDownloadValidator{header: "Last-Modified", value: oldModifiedAt.Format(http.TimeFormat)},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := systemReleaseDownloadValidatorFromHeaders(canonicalSystemReleaseHeaders(test.headers)); got != test.want {
				t.Fatalf("validator = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestSystemReleaseDownloaderRejectsInvalidContentRangeWithoutRetry(t *testing.T) {
	var attempts atomic.Int32
	downloader := newTestSystemReleaseDownloader(roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch attempts.Add(1) {
		case 1:
			return systemReleaseDownloadResponse(request, http.StatusOK, &singleReadErrorCloser{data: []byte("abc"), err: io.ErrUnexpectedEOF}, 6, http.Header{
				"ETag": []string{`"archive-v1"`},
			}), nil
		case 2:
			return systemReleaseDownloadResponse(request, http.StatusPartialContent, io.NopCloser(strings.NewReader("def")), 3, http.Header{
				"Content-Range": []string{"bytes 2-4/6"},
				"ETag":          []string{`"archive-v1"`},
			}), nil
		default:
			t.Fatalf("invalid range was retried")
			return nil, errors.New("unexpected attempt")
		}
	}))

	targetPath, _, err := downloadSystemReleaseForTest(t, downloader, 6, 6)
	if err == nil || !strings.Contains(err.Error(), "starts at 2, want 3") {
		t.Fatalf("download error = %v", err)
	}
	if attempts.Load() != 2 {
		t.Fatalf("attempts = %d, want 2", attempts.Load())
	}
	if _, statErr := os.Stat(targetPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("partial target still exists: %v", statErr)
	}
}

func TestSystemReleaseDownloaderRejectsSizeLimitWithoutRetry(t *testing.T) {
	var attempts atomic.Int32
	downloader := newTestSystemReleaseDownloader(roundTripFunc(func(request *http.Request) (*http.Response, error) {
		attempts.Add(1)
		return systemReleaseDownloadResponse(request, http.StatusOK, io.NopCloser(strings.NewReader("abcd")), 4, nil), nil
	}))

	if _, _, err := downloadSystemReleaseForTest(t, downloader, 4, 3); err == nil {
		t.Fatal("expected known oversized asset to be rejected")
	}
	if attempts.Load() != 0 {
		t.Fatalf("known oversized asset made %d requests", attempts.Load())
	}
	if _, _, err := downloadSystemReleaseForTest(t, downloader, 0, 3); err == nil {
		t.Fatal("expected oversized response to be rejected")
	}
	if attempts.Load() != 1 {
		t.Fatalf("oversized response attempts = %d, want 1", attempts.Load())
	}
}

func TestSystemReleaseDownloaderDoesNotRetryTargetFileFailures(t *testing.T) {
	var attempts atomic.Int32
	downloader := newTestSystemReleaseDownloader(roundTripFunc(func(request *http.Request) (*http.Response, error) {
		attempts.Add(1)
		return systemReleaseDownloadResponse(request, http.StatusOK, io.NopCloser(strings.NewReader("archive")), 7, nil), nil
	}))

	_, err := downloader.Download(context.Background(), "https://github.com/zhiyingzzhou/renewlet/releases/download/v1.2.3/archive.tar.gz", t.TempDir(), 7, 7)
	if err == nil {
		t.Fatal("expected target file creation failure")
	}
	if attempts.Load() != 0 {
		t.Fatalf("target file failure made %d requests", attempts.Load())
	}

	closedTarget, err := os.CreateTemp(t.TempDir(), "closed-target-*")
	if err != nil {
		t.Fatal(err)
	}
	if err := closedTarget.Close(); err != nil {
		t.Fatal(err)
	}
	result := readSystemReleaseDownloadBody(context.Background(), func() {}, strings.NewReader("archive"), &systemReleaseDownloadState{
		target:       closedTarget,
		hash:         sha256.New(),
		expectedSize: 7,
	}, 7, 0)
	if result.err == nil || result.retryable {
		t.Fatalf("closed target result = %#v", result)
	}
}

func TestSystemReleaseDownloaderDoesNotRetryCancellationOrCertificateErrors(t *testing.T) {
	t.Run("parent cancellation", func(t *testing.T) {
		var attempts atomic.Int32
		downloader := newTestSystemReleaseDownloader(roundTripFunc(func(request *http.Request) (*http.Response, error) {
			attempts.Add(1)
			return nil, request.Context().Err()
		}))
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, _, err := downloadSystemReleaseForTestContext(t, ctx, downloader, 0, 16)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("download error = %v, want context canceled", err)
		}
		if attempts.Load() > 1 {
			t.Fatalf("canceled download attempts = %d", attempts.Load())
		}
	})

	t.Run("certificate failure", func(t *testing.T) {
		var attempts atomic.Int32
		downloader := newTestSystemReleaseDownloader(roundTripFunc(func(*http.Request) (*http.Response, error) {
			attempts.Add(1)
			return nil, x509.UnknownAuthorityError{Cert: &x509.Certificate{}}
		}))
		_, _, err := downloadSystemReleaseForTest(t, downloader, 0, 16)
		if err == nil {
			t.Fatal("expected certificate failure")
		}
		if attempts.Load() != 1 {
			t.Fatalf("certificate failure attempts = %d, want 1", attempts.Load())
		}
	})
}

func TestSystemReleaseDownloaderRetriesOnlyApprovedStatuses(t *testing.T) {
	retryableStatuses := []int{
		http.StatusRequestTimeout,
		http.StatusTooManyRequests,
		http.StatusInternalServerError,
		http.StatusBadGateway,
		http.StatusServiceUnavailable,
		http.StatusGatewayTimeout,
	}
	for _, status := range retryableStatuses {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var attempts atomic.Int32
			downloader := newTestSystemReleaseDownloader(roundTripFunc(func(request *http.Request) (*http.Response, error) {
				attempts.Add(1)
				return systemReleaseDownloadResponse(request, status, io.NopCloser(strings.NewReader("upstream failed")), 15, nil), nil
			}))
			if _, _, err := downloadSystemReleaseForTest(t, downloader, 0, 32); err == nil {
				t.Fatal("expected status failure")
			}
			if attempts.Load() != systemUpdateDownloadMaxAttempts {
				t.Fatalf("attempts = %d, want %d", attempts.Load(), systemUpdateDownloadMaxAttempts)
			}
		})
	}

	var attempts atomic.Int32
	downloader := newTestSystemReleaseDownloader(roundTripFunc(func(request *http.Request) (*http.Response, error) {
		attempts.Add(1)
		return systemReleaseDownloadResponse(request, http.StatusNotFound, io.NopCloser(strings.NewReader("missing")), 7, nil), nil
	}))
	if _, _, err := downloadSystemReleaseForTest(t, downloader, 0, 32); err == nil {
		t.Fatal("expected non-retryable status failure")
	}
	if attempts.Load() != 1 {
		t.Fatalf("404 attempts = %d, want 1", attempts.Load())
	}
}

func TestSystemReleaseDownloaderHonorsBoundedRetryAfter(t *testing.T) {
	content := []byte("archive")
	var attempts atomic.Int32
	downloader := newTestSystemReleaseDownloader(roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if attempts.Add(1) == 1 {
			return systemReleaseDownloadResponse(request, http.StatusServiceUnavailable, io.NopCloser(strings.NewReader("busy")), 4, http.Header{
				"Retry-After": []string{"12"},
			}), nil
		}
		return systemReleaseDownloadResponse(request, http.StatusOK, io.NopCloser(strings.NewReader(string(content))), int64(len(content)), nil), nil
	}))
	var waits []time.Duration
	downloader.wait = func(_ context.Context, delay time.Duration) error {
		waits = append(waits, delay)
		return nil
	}

	targetPath, checksum, err := downloadSystemReleaseForTest(t, downloader, int64(len(content)), int64(len(content)))
	if err != nil {
		t.Fatal(err)
	}
	assertSystemReleaseDownload(t, targetPath, content, checksum)
	if len(waits) != 1 || waits[0] != 12*time.Second {
		t.Fatalf("retry waits = %v, want [12s]", waits)
	}

	var longAttempts atomic.Int32
	longRetryAfter := newTestSystemReleaseDownloader(roundTripFunc(func(request *http.Request) (*http.Response, error) {
		longAttempts.Add(1)
		return systemReleaseDownloadResponse(request, http.StatusTooManyRequests, io.NopCloser(strings.NewReader("limited")), 7, http.Header{
			"Retry-After": []string{"31"},
		}), nil
	}))
	if _, _, err := downloadSystemReleaseForTest(t, longRetryAfter, 0, 32); err == nil {
		t.Fatal("expected bounded Retry-After failure")
	}
	if longAttempts.Load() != 1 {
		t.Fatalf("long Retry-After attempts = %d, want 1", longAttempts.Load())
	}
}

func TestSystemReleaseDownloaderUsesExponentialFullJitterBounds(t *testing.T) {
	downloader := newTestSystemReleaseDownloader(roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("unused")
	}))
	downloader.policy.retryBase = 500 * time.Millisecond
	downloader.policy.retryMax = 5 * time.Second
	var maximums []time.Duration
	downloader.jitter = func(maximum time.Duration) time.Duration {
		maximums = append(maximums, maximum)
		return maximum / 2
	}

	policy := downloader.normalizedPolicy()
	if delay := downloader.retryDelay(1, policy); delay != 250*time.Millisecond {
		t.Fatalf("first retry delay = %s", delay)
	}
	if delay := downloader.retryDelay(2, policy); delay != 500*time.Millisecond {
		t.Fatalf("second retry delay = %s", delay)
	}
	if len(maximums) != 2 || maximums[0] != 500*time.Millisecond || maximums[1] != time.Second {
		t.Fatalf("jitter bounds = %v", maximums)
	}
}

func TestSystemReleaseDownloaderDoesNotRetryOrdinaryBodyErrors(t *testing.T) {
	var attempts atomic.Int32
	downloader := newTestSystemReleaseDownloader(roundTripFunc(func(request *http.Request) (*http.Response, error) {
		attempts.Add(1)
		return systemReleaseDownloadResponse(request, http.StatusOK, &singleReadErrorCloser{err: errors.New("invalid response framing")}, -1, nil), nil
	}))
	_, _, err := downloadSystemReleaseForTest(t, downloader, 0, 16)
	if err == nil || !strings.Contains(err.Error(), "invalid response framing") {
		t.Fatalf("download error = %v", err)
	}
	if attempts.Load() != 1 {
		t.Fatalf("body error attempts = %d, want 1", attempts.Load())
	}
}

func newTestSystemReleaseDownloader(transport http.RoundTripper) *systemReleaseDownloader {
	downloader := newSystemReleaseDownloader(&http.Client{Transport: transport})
	downloader.policy = systemReleaseDownloadPolicy{
		maxAttempts:   systemUpdateDownloadMaxAttempts,
		idleTimeout:   time.Second,
		retryBase:     time.Nanosecond,
		retryMax:      time.Nanosecond,
		maxRetryAfter: systemUpdateDownloadMaxRetryAfter,
	}
	downloader.jitter = func(time.Duration) time.Duration { return 0 }
	downloader.wait = func(context.Context, time.Duration) error { return nil }
	downloader.now = func() time.Time { return time.Date(2026, time.August, 24, 12, 0, 0, 0, time.UTC) }
	return downloader
}

func downloadSystemReleaseForTest(t *testing.T, downloader *systemReleaseDownloader, expectedSize int64, maxBytes int64) (string, string, error) {
	t.Helper()
	return downloadSystemReleaseForTestContext(t, context.Background(), downloader, expectedSize, maxBytes)
}

func downloadSystemReleaseForTestContext(t *testing.T, ctx context.Context, downloader *systemReleaseDownloader, expectedSize int64, maxBytes int64) (string, string, error) {
	t.Helper()
	targetPath := filepath.Join(t.TempDir(), "archive.tar.gz")
	checksum, err := downloader.Download(ctx, "https://github.com/zhiyingzzhou/renewlet/releases/download/v1.2.3/archive.tar.gz", targetPath, expectedSize, maxBytes)
	return targetPath, checksum, err
}

func systemReleaseDownloadResponse(request *http.Request, status int, body io.ReadCloser, contentLength int64, headers http.Header) *http.Response {
	return &http.Response{
		StatusCode:    status,
		Status:        http.StatusText(status),
		Header:        canonicalSystemReleaseHeaders(headers),
		Body:          body,
		ContentLength: contentLength,
		Request:       request,
	}
}

func canonicalSystemReleaseHeaders(headers http.Header) http.Header {
	canonical := make(http.Header, len(headers))
	for name, values := range headers {
		for _, value := range values {
			canonical.Add(name, value)
		}
	}
	return canonical
}

func assertSystemReleaseDownload(t *testing.T, targetPath string, expected []byte, checksum string) {
	t.Helper()
	written, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(written) != string(expected) {
		t.Fatalf("downloaded content = %q, want %q", written, expected)
	}
	sum := sha256.Sum256(expected)
	if checksum != hex.EncodeToString(sum[:]) {
		t.Fatalf("checksum = %q, want %q", checksum, hex.EncodeToString(sum[:]))
	}
}

type delayedByteReadCloser struct {
	data   []byte
	delay  time.Duration
	offset int
}

func (body *delayedByteReadCloser) Read(target []byte) (int, error) {
	if body.offset >= len(body.data) {
		return 0, io.EOF
	}
	time.Sleep(body.delay)
	target[0] = body.data[body.offset]
	body.offset++
	return 1, nil
}

func (body *delayedByteReadCloser) Close() error { return nil }

type partialThenContextReadCloser struct {
	data []byte
	ctx  context.Context
	sent bool
}

func (body *partialThenContextReadCloser) Read(target []byte) (int, error) {
	if !body.sent {
		body.sent = true
		return copy(target, body.data), nil
	}
	<-body.ctx.Done()
	return 0, body.ctx.Err()
}

func (body *partialThenContextReadCloser) Close() error { return nil }

type singleReadErrorCloser struct {
	data []byte
	err  error
	sent bool
}

func (body *singleReadErrorCloser) Read(target []byte) (int, error) {
	if body.sent {
		return 0, body.err
	}
	body.sent = true
	return copy(target, body.data), body.err
}

func (body *singleReadErrorCloser) Close() error { return nil }
