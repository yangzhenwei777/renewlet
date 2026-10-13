package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// 远端响应测试保护结构化阶段、状态、能力提示与脱敏边界。
func TestS3CloudBackupListIncludesStructuredDetails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got == "" {
			t.Fatalf("signed request missing Authorization header")
		}
		w.Header().Set("Content-Type", "application/xml")
		w.Header().Set("Authorization", "should-not-echo")
		w.Header().Set("Set-Cookie", "session=secret-key")
		w.Header().Set("x-amz-security-token", "secret-key")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`<Error><Code>AccessDenied</Code><Message>access-key secret-key missing list permission</Message></Error>`))
	}))
	t.Cleanup(server.Close)

	client := newS3CloudBackupClient(cloudBackupS3Settings{
		Endpoint:    server.URL,
		Region:      "us-east-1",
		Bucket:      "renewlet",
		Prefix:      cloudBackupStringPtr("snapshots"),
		AccessKeyID: "access-key",
	}, "secret-key")

	_, err := client.List(context.Background())
	if err == nil {
		t.Fatal("expected list error")
	}
	var remoteErr *cloudBackupRemoteError
	if !errors.As(err, &remoteErr) {
		t.Fatalf("expected cloudBackupRemoteError, got %T", err)
	}
	if remoteErr.code != "CLOUD_BACKUP_S3_LIST_FAILED" {
		t.Fatalf("unexpected code: %s", remoteErr.code)
	}
	if remoteErr.details == nil || remoteErr.details.ProviderMessage == "" {
		t.Fatalf("missing provider response: %#v", remoteErr.details)
	}
	if !strings.Contains(remoteErr.details.ProviderMessage, "AccessDenied") {
		t.Fatalf("missing upstream body: %#v", remoteErr.details)
	}
	if remoteErr.details.HTTPStatus == nil || *remoteErr.details.HTTPStatus != http.StatusForbidden || remoteErr.details.HTTPStatusText != "Forbidden" {
		t.Fatalf("missing HTTP status details: %#v", remoteErr.details)
	}
	if remoteErr.details.RequiredCapability != "bucket listing permission" {
		t.Fatalf("missing list permission hint: %#v", remoteErr.details)
	}
	if !strings.Contains(remoteErr.details.Target, "bucket=renewlet") || !strings.Contains(remoteErr.details.Target, "key=snapshots/") {
		t.Fatalf("missing redacted target: %#v", remoteErr.details)
	}
	payload := remoteErr.details.ProviderMessage
	for _, leaked := range []string{"access-key", "secret-key", "should-not-echo"} {
		if strings.Contains(payload, leaked) {
			t.Fatalf("sensitive value %q leaked in raw response: %#v", leaked, remoteErr.details)
		}
	}
}

func TestS3CloudBackupListPreservesSDKErrorForSuccessfulResponse(t *testing.T) {
	transport := cloudBackupRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Header:     http.Header{"Content-Type": []string{"application/xml"}},
			Body:       io.NopCloser(strings.NewReader("not xml")),
			Request:    request,
		}, nil
	})
	client := newS3CloudBackupClient(cloudBackupS3Settings{
		Endpoint:    "https://storage.example.com",
		Region:      "us-east-1",
		Bucket:      "renewlet",
		Prefix:      cloudBackupStringPtr("snapshots"),
		AccessKeyID: "access-key",
	}, "secret-key")
	capture := &s3ProviderResponseCapture{}
	client.capture = capture
	client.client = newS3SDKClient(client.settings, client.secret, &s3CaptureHTTPClient{
		client:  &http.Client{Transport: transport},
		capture: capture,
		secrets: []string{"access-key", "secret-key"},
	})

	_, err := client.List(context.Background())
	if err == nil {
		t.Fatal("expected SDK deserialization failure")
	}
	remoteErr := cloudBackupRemoteErrorFrom(err)
	if remoteErr == nil || remoteErr.code != "CLOUD_BACKUP_S3_LIST_FAILED" {
		t.Fatalf("expected list failure, got %#v", err)
	}
	if remoteErr.details == nil || remoteErr.details.ProviderMessage == "" {
		t.Fatalf("missing successful-response diagnostic: %#v", remoteErr.details)
	}
	if remoteErr.details.ProviderMessage != "not xml" || remoteErr.details.ClientMessage == "" {
		t.Fatalf("expected separate response body and local parser error: %#v", remoteErr.details)
	}
	if remoteErr.details.ProviderCode != "" || remoteErr.details.HTTPStatus == nil || *remoteErr.details.HTTPStatus != http.StatusOK {
		t.Fatalf("local parsing error must not become a provider error code: %#v", remoteErr.details)
	}
}

func TestS3CloudBackupUploadCleansZipWhenHeadForbidden(t *testing.T) {
	var methods []string
	transport := cloudBackupRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		methods = append(methods, request.Method)
		if request.Method == http.MethodHead {
			return &http.Response{StatusCode: http.StatusForbidden, Status: "403 Forbidden", Header: http.Header{}, Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
		}
		status := http.StatusOK
		if request.Method == http.MethodDelete {
			status = http.StatusNoContent
		}
		return &http.Response{StatusCode: status, Status: http.StatusText(status), Header: http.Header{}, Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
	})
	client := newS3CloudBackupClient(cloudBackupS3Settings{
		Endpoint:    "https://storage.example.com",
		Region:      "us-east-1",
		Bucket:      "renewlet",
		Prefix:      cloudBackupStringPtr("snapshots"),
		AccessKeyID: "access-key",
	}, "secret-key")
	capture := &s3ProviderResponseCapture{}
	client.capture = capture
	client.client = newS3SDKClient(client.settings, client.secret, &s3CaptureHTTPClient{
		client:  &http.Client{Transport: transport},
		capture: capture,
		secrets: []string{"access-key", "secret-key"},
	})
	content := []byte("renewlet")
	manifest := cloudBackupManifestForTest("renewlet-export-v1-20260609T000000Z-head", content)
	err := client.Upload(context.Background(), manifest.Filename, cloudBackupSnapshotSourceForTest(t, content), manifest)
	if err == nil {
		t.Fatal("expected HeadObject failure")
	}
	remoteErr := cloudBackupRemoteErrorFrom(err)
	if remoteErr == nil || remoteErr.code != "CLOUD_BACKUP_S3_HEAD_FAILED" {
		t.Fatalf("expected HeadObject failure, got %#v", err)
	}
	if remoteErr.details == nil || remoteErr.details.HTTPStatus == nil || *remoteErr.details.HTTPStatus != http.StatusForbidden || remoteErr.details.RequiredCapability != "object read permission" {
		t.Fatalf("missing S3 upload diagnostic: %#v", remoteErr.details)
	}
	if got, want := methods, []string{http.MethodPut, http.MethodHead, http.MethodDelete}; !reflect.DeepEqual(got, want) {
		t.Fatalf("expected failed upload cleanup sequence %v, got %v", want, got)
	}
}

func TestS3CloudBackupUploadCleansZipAndManifestWhenManifestFails(t *testing.T) {
	var methods []string
	putCount := 0
	transport := cloudBackupRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		methods = append(methods, request.Method)
		if request.Method == http.MethodPut {
			putCount++
			if putCount == 2 {
				return &http.Response{StatusCode: http.StatusForbidden, Status: "403 Forbidden", Header: http.Header{}, Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
			}
		}
		status := http.StatusOK
		if request.Method == http.MethodHead {
			status = http.StatusOK
		}
		if request.Method == http.MethodDelete {
			status = http.StatusNoContent
		}
		headers := http.Header{}
		if request.Method == http.MethodHead {
			headers.Set("Content-Length", "8")
		}
		return &http.Response{StatusCode: status, Status: http.StatusText(status), Header: headers, Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
	})
	client := newS3CloudBackupClient(cloudBackupS3Settings{
		Endpoint:    "https://storage.example.com",
		Region:      "us-east-1",
		Bucket:      "renewlet",
		Prefix:      cloudBackupStringPtr("snapshots"),
		AccessKeyID: "access-key",
	}, "secret-key")
	capture := &s3ProviderResponseCapture{}
	client.capture = capture
	client.client = newS3SDKClient(client.settings, client.secret, &s3CaptureHTTPClient{
		client:  &http.Client{Transport: transport},
		capture: capture,
		secrets: []string{"access-key", "secret-key"},
	})
	content := []byte("renewlet")
	manifest := cloudBackupManifestForTest("renewlet-export-v1-20260609T000000Z-manifest", content)
	err := client.Upload(context.Background(), manifest.Filename, cloudBackupSnapshotSourceForTest(t, content), manifest)
	if err == nil {
		t.Fatal("expected manifest failure")
	}
	remoteErr := cloudBackupRemoteErrorFrom(err)
	if remoteErr == nil || remoteErr.code != "CLOUD_BACKUP_S3_PUT_FAILED" {
		t.Fatalf("expected manifest PUT failure, got %#v", err)
	}
	if remoteErr.details == nil || !strings.Contains(remoteErr.details.Target, "key=snapshots/"+manifest.ID+".manifest.json") {
		t.Fatalf("missing manifest diagnostic: %#v", remoteErr.details)
	}
	if got, want := methods, []string{http.MethodPut, http.MethodHead, http.MethodPut, http.MethodDelete, http.MethodDelete}; !reflect.DeepEqual(got, want) {
		t.Fatalf("expected manifest cleanup sequence %v, got %v", want, got)
	}
}

func TestS3CloudBackupAddressingStyles(t *testing.T) {
	tests := []struct {
		name             string
		endpoint         string
		addressingStyle  string
		expectedHost     string
		expectedPath     string
		unexpectedHost   string
		unexpectedPrefix string
	}{
		{
			name:             "SDK auto endpoint",
			endpoint:         "https://example.com",
			addressingStyle:  cloudBackupS3AddressingAuto,
			expectedHost:     "renewlet.example.com",
			expectedPath:     "/",
			unexpectedHost:   "example.com",
			unexpectedPrefix: "/renewlet/",
		},
		{
			name:             "explicit path style",
			endpoint:         "https://storage.example.com:9000",
			addressingStyle:  cloudBackupS3AddressingPathStyle,
			expectedHost:     "storage.example.com:9000",
			expectedPath:     "/renewlet",
			unexpectedHost:   "renewlet.storage.example.com:9000",
			unexpectedPrefix: "/snapshots/",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotHost string
			var gotPath string
			var gotQuery string
			transport := cloudBackupRoundTripFunc(func(request *http.Request) (*http.Response, error) {
				gotHost = request.URL.Host
				gotPath = request.URL.Path
				gotQuery = request.URL.RawQuery
				return &http.Response{
					StatusCode: http.StatusOK,
					Status:     "200 OK",
					Header:     http.Header{"Content-Type": []string{"application/xml"}},
					Body:       io.NopCloser(strings.NewReader(`<?xml version="1.0"?><ListBucketResult></ListBucketResult>`)),
					Request:    request,
				}, nil
			})
			client := newS3CloudBackupClient(cloudBackupS3Settings{
				Endpoint:        tt.endpoint,
				Region:          "us-east-1",
				Bucket:          "renewlet",
				Prefix:          cloudBackupStringPtr("snapshots"),
				AccessKeyID:     "access-key",
				AddressingStyle: tt.addressingStyle,
			}, "secret-key")
			client.capture = &s3ProviderResponseCapture{}
			client.client = newS3SDKClient(client.settings, client.secret, &http.Client{Transport: transport})

			if _, err := client.List(context.Background()); err != nil {
				t.Fatalf("expected list to succeed: %v", err)
			}
			if gotHost != tt.expectedHost {
				t.Fatalf("expected host %q, got %q", tt.expectedHost, gotHost)
			}
			if gotPath != tt.expectedPath {
				t.Fatalf("expected path %q, got %q", tt.expectedPath, gotPath)
			}
			if gotHost == tt.unexpectedHost || strings.HasPrefix(gotPath, tt.unexpectedPrefix) && gotPath != tt.expectedPath {
				t.Fatalf("addressing style leaked old shape: host=%q path=%q", gotHost, gotPath)
			}
			if !strings.Contains(gotQuery, "list-type=2") || !strings.Contains(gotQuery, "prefix=snapshots%2F") {
				t.Fatalf("expected list query, got %q", gotQuery)
			}
		})
	}
}

func TestS3CloudBackupRootPrefixOmitsListPrefixParameter(t *testing.T) {
	var gotQuery string
	transport := cloudBackupRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		gotQuery = request.URL.RawQuery
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Header:     http.Header{"Content-Type": []string{"application/xml"}},
			Body:       io.NopCloser(strings.NewReader(`<?xml version="1.0"?><ListBucketResult></ListBucketResult>`)),
			Request:    request,
		}, nil
	})
	client := newS3CloudBackupClient(cloudBackupS3Settings{
		Endpoint:    "https://example.com",
		Region:      "us-east-1",
		Bucket:      "renewlet",
		Prefix:      cloudBackupStringPtr(""),
		AccessKeyID: "access-key",
	}, "secret-key")
	client.client = newS3SDKClient(client.settings, client.secret, &http.Client{Transport: transport})

	if _, err := client.List(context.Background()); err != nil {
		t.Fatalf("expected root list to succeed: %v", err)
	}
	if strings.Contains(gotQuery, "prefix=") {
		t.Fatalf("root list unexpectedly constrained by prefix: %q", gotQuery)
	}
}

func TestS3CloudBackupUsesExplicitSigningRegion(t *testing.T) {
	var gotAuthorization string
	transport := cloudBackupRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		gotAuthorization = request.Header.Get("Authorization")
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Header:     http.Header{"Content-Type": []string{"application/xml"}},
			Body:       io.NopCloser(strings.NewReader(`<?xml version="1.0"?><ListBucketResult></ListBucketResult>`)),
			Request:    request,
		}, nil
	})
	client := newS3CloudBackupClient(cloudBackupS3Settings{
		Endpoint:    "https://example.com",
		Region:      "auto",
		Bucket:      "renewlet",
		Prefix:      cloudBackupStringPtr("snapshots"),
		AccessKeyID: "access-key",
	}, "secret-key")
	client.client = newS3SDKClient(client.settings, client.secret, &http.Client{Transport: transport})

	_, err := client.List(context.Background())
	if err != nil {
		t.Fatalf("expected list to succeed: %v", err)
	}
	if !strings.Contains(gotAuthorization, "/auto/s3/aws4_request") {
		t.Fatalf("expected explicit signing region in credential scope, got %q", gotAuthorization)
	}
}

func TestS3CloudBackupTestIncludesListProbe(t *testing.T) {
	var sawList bool
	probeContent := "renewlet-cloud-backup-probe"
	probeContentLength := strconv.Itoa(len(probeContent))
	transport := cloudBackupRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		if strings.Contains(request.URL.RawQuery, "list-type=2") {
			sawList = true
			return &http.Response{
				StatusCode: http.StatusForbidden,
				Status:     "403 Forbidden",
				Header:     http.Header{"Content-Type": []string{"application/xml"}},
				Body:       io.NopCloser(strings.NewReader(`<Error><Code>AccessDenied</Code></Error>`)),
				Request:    request,
			}, nil
		}
		if request.Method == http.MethodHead {
			return &http.Response{
				StatusCode: http.StatusOK,
				Status:     "200 OK",
				Header:     http.Header{"Content-Length": []string{probeContentLength}},
				Body:       io.NopCloser(strings.NewReader("")),
				Request:    request,
			}, nil
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Header:     http.Header{"Content-Length": []string{probeContentLength}},
			Body:       io.NopCloser(strings.NewReader(probeContent)),
			Request:    request,
		}, nil
	})
	client := newS3CloudBackupClient(cloudBackupS3Settings{
		Endpoint:    "https://example.com",
		Region:      "us-east-1",
		Bucket:      "renewlet",
		Prefix:      cloudBackupStringPtr("snapshots"),
		AccessKeyID: "access-key",
	}, "secret-key")
	capture := &s3ProviderResponseCapture{}
	client.capture = capture
	client.client = newS3SDKClient(client.settings, client.secret, &s3CaptureHTTPClient{
		client:  &http.Client{Transport: transport},
		capture: capture,
		secrets: []string{"access-key", "secret-key"},
	})

	err := client.Test(context.Background())
	if err == nil {
		t.Fatal("expected list probe to fail")
	}
	if !sawList {
		t.Fatal("expected test connection to call ListObjectsV2")
	}
	remoteErr := cloudBackupRemoteErrorFrom(err)
	if remoteErr == nil || remoteErr.code != "CLOUD_BACKUP_S3_LIST_FAILED" {
		t.Fatalf("expected list failure with provider response, got %#v", err)
	}
}

func TestCloudBackupPersistedErrorMessageRedactsUpstreamBody(t *testing.T) {
	body := `<Error><Code>AccessDenied</Code><Message>missing list permission</Message></Error>`
	err := &cloudBackupRemoteError{
		code: "CLOUD_BACKUP_S3_LIST_FAILED",
		details: &cloudBackupErrorDetails{
			Operation:       "ListObjectsV2",
			Target:          "bucket=renewlet; key=(bucket root)",
			ProviderMessage: body,
		},
	}

	message := persistedCloudBackupErrorMessage(err)

	if strings.Contains(message, "AccessDenied") || strings.Contains(message, "missing list permission") {
		t.Fatalf("persisted message leaked upstream body: %s", message)
	}
	if message != "CLOUD_BACKUP_S3_LIST_FAILED" {
		t.Fatalf("persisted message lost useful summary: %s", message)
	}
}

func TestCloudBackupLocalErrorDetails(t *testing.T) {
	details := cloudBackupLocalErrorDetails("", "local", "cloud backup", "Value out of range. Must be between -2147483648 and 2147483647 (inclusive).")

	if !strings.Contains(details.ClientMessage, "Value out of range") {
		t.Fatalf("missing local error: %#v", details)
	}
}

func TestS3CloudBackupLocalNetworkErrorUsesRedactedRequestContext(t *testing.T) {
	transport := cloudBackupRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		return nil, errors.New("Network connection lost.")
	})
	client := newS3CloudBackupClient(cloudBackupS3Settings{
		Endpoint:    "https://cloud-storage.example.com",
		Region:      "ap-shanghai",
		Bucket:      "cloud-storage-1234567890",
		Prefix:      cloudBackupStringPtr("snapshots"),
		AccessKeyID: "access-key",
	}, "secret-key")
	capture := &s3ProviderResponseCapture{}
	client.capture = capture
	client.client = newS3SDKClient(client.settings, client.secret, &s3CaptureHTTPClient{
		client:  &http.Client{Transport: transport},
		capture: capture,
		secrets: []string{"access-key", "secret-key"},
	})

	_, err := client.List(context.Background())
	if err == nil {
		t.Fatal("expected list to fail")
	}
	remoteErr := cloudBackupRemoteErrorFrom(err)
	if remoteErr == nil || remoteErr.details == nil {
		t.Fatalf("expected structured local S3 error, got %#v", err)
	}
	details := remoteErr.details
	if !strings.Contains(details.ClientMessage, "Network connection lost.") || !strings.Contains(details.Target, "host=cloud-storage-1234567890.cloud-storage.example.com") {
		t.Fatalf("missing S3 request target in local error: %#v", details)
	}
	serialized := fmt.Sprintf("%#v", details)
	for _, leaked := range []string{"access-key", "secret-key", "Authorization", "X-Amz-Signature"} {
		if strings.Contains(serialized, leaked) {
			t.Fatalf("sensitive value %q leaked in local raw response: %s", leaked, serialized)
		}
	}
}

func TestWebDAVCloudBackupLocalNetworkErrorUsesRedactedRequestContext(t *testing.T) {
	capture := &webDAVProviderResponseCapture{}
	client := newWebDAVCloudBackupClient(cloudBackupWebDAVSettings{
		URL:      "https://webdav.example.com/remote.php/dav/files/alice",
		Username: "alice",
		Path:     "renewlet",
	}, "webdav-secret")
	client.capture = capture
	client.client.SetTransport(&webDAVCaptureTransport{
		base: cloudBackupRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			return nil, errors.New("Network connection lost for " + request.URL.String() + " webdav-secret")
		}),
		capture: capture,
		secrets: []string{"webdav-secret"},
	})

	_, err := client.List(context.Background())
	remoteErr := cloudBackupRemoteErrorFrom(err)
	if remoteErr == nil || remoteErr.code != "CLOUD_BACKUP_WEBDAV_MKCOL_FAILED" || remoteErr.details == nil || remoteErr.details.ClientMessage == "" {
		t.Fatalf("expected structured WebDAV local error, got %#v", err)
	}
	if !strings.Contains(remoteErr.details.ClientMessage, "Network connection lost") || !strings.Contains(remoteErr.details.Target, "host=webdav.example.com") {
		t.Fatalf("expected WebDAV diagnostic context, got %#v", remoteErr.details)
	}
	if strings.Contains(remoteErr.details.ClientMessage, "webdav-secret") {
		t.Fatalf("WebDAV diagnostic leaked password: %q", remoteErr.details.ClientMessage)
	}
}

func TestWebDAVCloudBackupSDKAdapterRoundTrip(t *testing.T) {
	server, state := newFakeWebDAVServer(t)
	defer server.Close()
	client := newWebDAVCloudBackupClient(cloudBackupWebDAVSettings{
		URL:      server.URL + "/remote.php/dav/files/alice",
		Username: "alice",
		Path:     "renewlet",
	}, "webdav-secret")
	content := []byte("renewlet")
	manifest := cloudBackupManifestForTest("renewlet-export-v1-20260609T000000Z-webdav", content)

	if err := client.Test(context.Background()); err != nil {
		t.Fatalf("expected WebDAV test to succeed: %v", err)
	}
	if err := client.Upload(context.Background(), manifest.Filename, cloudBackupSnapshotSourceForTest(t, content), manifest); err != nil {
		t.Fatalf("expected upload to succeed: %v", err)
	}
	manifests, err := client.List(context.Background())
	if err != nil {
		t.Fatalf("expected list to succeed: %v", err)
	}
	if len(manifests) != 1 || manifests[0].ID != manifest.ID {
		t.Fatalf("expected uploaded manifest, got %#v", manifests)
	}
	got, gotManifest, err := client.Download(context.Background(), manifest.ID)
	if err != nil {
		t.Fatalf("expected download to succeed: %v", err)
	}
	if !strings.Contains(string(got), "renewlet") || gotManifest.ID != manifest.ID {
		t.Fatalf("unexpected download content=%q manifest=%#v", string(got), gotManifest)
	}
	if err := client.Delete(context.Background(), manifest.ID); err != nil {
		t.Fatalf("expected delete to succeed: %v", err)
	}
	for _, method := range []string{"MKCOL", "PROPFIND", "PUT", "GET", "DELETE"} {
		if !state.methods[method] {
			t.Fatalf("expected SDK adapter to issue %s, saw %#v", method, state.methods)
		}
	}
}

func TestWebDAVCloudBackupUploadCleansZipWhenManifestFails(t *testing.T) {
	state := newFakeWebDAVState()
	var methods []string
	putCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method)
		if r.Method == http.MethodPut {
			putCount++
			if putCount == 2 {
				w.WriteHeader(http.StatusForbidden)
				return
			}
		}
		state.handle(t, w, r)
	}))
	defer server.Close()
	client := newWebDAVCloudBackupClient(cloudBackupWebDAVSettings{
		URL:      server.URL + "/remote.php/dav/files/alice",
		Username: "alice",
		Path:     "renewlet",
	}, "webdav-secret")
	content := []byte("renewlet")
	manifest := cloudBackupManifestForTest("renewlet-export-v1-20260609T000000Z-webdav-failure", content)

	err := client.Upload(context.Background(), manifest.Filename, cloudBackupSnapshotSourceForTest(t, content), manifest)
	remoteErr := cloudBackupRemoteErrorFrom(err)
	if remoteErr == nil || remoteErr.code != "CLOUD_BACKUP_WEBDAV_PUT_FAILED" {
		t.Fatalf("expected manifest PUT failure, got %#v", err)
	}
	filtered := []string{}
	for _, method := range methods {
		if method == http.MethodPut || method == http.MethodDelete {
			filtered = append(filtered, method)
		}
	}
	if want := []string{http.MethodPut, http.MethodPut, http.MethodDelete, http.MethodDelete}; !reflect.DeepEqual(filtered, want) {
		t.Fatalf("expected WebDAV failed upload cleanup sequence %v, got %v", want, filtered)
	}
}

func TestWebDAVCloudBackupTestIncludesListProbe(t *testing.T) {
	state := newFakeWebDAVState()
	failList := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PROPFIND" && r.Header.Get("Depth") == "1" && failList {
			state.methods[r.Method] = true
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`<d:error xmlns:d="DAV:"><d:message>list denied</d:message></d:error>`))
			return
		}
		state.handle(t, w, r)
	}))
	defer server.Close()
	client := newWebDAVCloudBackupClient(cloudBackupWebDAVSettings{
		URL:      server.URL + "/remote.php/dav/files/alice",
		Username: "alice",
		Path:     "renewlet",
	}, "webdav-secret")
	failList = true

	err := client.Test(context.Background())
	if err == nil {
		t.Fatal("expected list probe to fail")
	}
	remoteErr := cloudBackupRemoteErrorFrom(err)
	if remoteErr == nil || remoteErr.code != "CLOUD_BACKUP_WEBDAV_PROPFIND_FAILED" {
		t.Fatalf("expected PROPFIND provider error, got %#v", err)
	}
	if !state.methods["PROPFIND"] {
		t.Fatal("expected test connection to call PROPFIND")
	}
}

func TestWebDAVCloudBackupProviderResponses(t *testing.T) {
	tests := []struct {
		name     string
		status   int
		body     string
		wantBody string
	}{
		{name: "empty 401", status: http.StatusUnauthorized, body: "", wantBody: ""},
		{name: "xml 403", status: http.StatusForbidden, body: `<d:error xmlns:d="DAV:"><d:message>denied webdav-secret</d:message></d:error>`, wantBody: "denied [redacted]"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Authorization", "Basic webdav-secret")
				w.Header().Set("Server", "fake-webdav")
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer server.Close()
			client := newWebDAVCloudBackupClient(cloudBackupWebDAVSettings{
				URL:      server.URL + "/remote.php/dav/files/alice",
				Username: "alice",
				Path:     "renewlet",
			}, "webdav-secret")

			_, err := client.List(context.Background())
			if err == nil {
				t.Fatal("expected WebDAV provider error")
			}
			remoteErr := cloudBackupRemoteErrorFrom(err)
			if remoteErr == nil || remoteErr.details == nil {
				t.Fatalf("expected structured response, got %#v", err)
			}
			if tt.wantBody == "" {
				if remoteErr.details.HTTPStatus == nil || *remoteErr.details.HTTPStatus != tt.status || remoteErr.details.HTTPStatusText != http.StatusText(tt.status) {
					t.Fatalf("expected status fallback, got %#v", remoteErr.details)
				}
				if remoteErr.details.RequiredCapability != "object write permission" {
					t.Fatalf("missing WebDAV capability hint, got %#v", remoteErr.details)
				}
				return
			}
			if !strings.Contains(remoteErr.details.ProviderMessage, tt.wantBody) {
				t.Fatalf("expected redacted upstream body %q, got %#v", tt.wantBody, remoteErr.details)
			}
			if remoteErr.details.RequiredCapability != "object write permission" {
				t.Fatalf("missing WebDAV capability hint, got %#v", remoteErr.details)
			}
			if strings.Contains(remoteErr.details.ProviderMessage, "webdav-secret") {
				t.Fatalf("WebDAV password leaked in provider response: %#v", remoteErr.details)
			}
		})
	}
}

type cloudBackupRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn cloudBackupRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func newFakeWebDAVServer(t *testing.T) (*httptest.Server, *fakeWebDAVState) {
	t.Helper()
	state := newFakeWebDAVState()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state.handle(t, w, r)
	}))
	return server, state
}

func newFakeWebDAVState() *fakeWebDAVState {
	return &fakeWebDAVState{
		methods:     map[string]bool{},
		directories: map[string]bool{"/remote.php/dav/files/alice/": true},
		files:       map[string][]byte{},
	}
}

type fakeWebDAVState struct {
	methods     map[string]bool
	directories map[string]bool
	files       map[string][]byte
}

func (state *fakeWebDAVState) handle(t *testing.T, w http.ResponseWriter, r *http.Request) {
	t.Helper()
	state.methods[r.Method] = true
	target := cleanFakeWebDAVPath(r.URL.Path)
	switch r.Method {
	case "MKCOL":
		state.directories[target] = true
		w.WriteHeader(http.StatusCreated)
	case "PROPFIND":
		if !state.directories[target] {
			if body, ok := state.files[target]; ok {
				w.Header().Set("Content-Type", "application/xml")
				w.WriteHeader(207)
				_, _ = w.Write([]byte(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">` + fakeWebDAVResponse(target, false, len(body)) + `</d:multistatus>`))
				return
			}
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(207)
		_, _ = w.Write([]byte(state.multiStatus(target)))
	case "PUT":
		body, _ := io.ReadAll(r.Body)
		state.files[target] = body
		w.WriteHeader(http.StatusCreated)
	case "GET":
		body, ok := state.files[target]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	case "DELETE":
		if _, ok := state.files[target]; !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		delete(state.files, target)
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func cleanFakeWebDAVPath(value string) string {
	value = "/" + strings.Trim(value, "/")
	if strings.HasSuffix(value, "/") {
		return value
	}
	if strings.Contains(path.Base(value), ".") {
		return value
	}
	return value + "/"
}

func (state *fakeWebDAVState) multiStatus(directory string) string {
	builder := strings.Builder{}
	builder.WriteString(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">`)
	builder.WriteString(fakeWebDAVResponse(directory, true, 0))
	for filename, body := range state.files {
		if path.Dir(filename)+"/" == directory {
			builder.WriteString(fakeWebDAVResponse(filename, false, len(body)))
		}
	}
	builder.WriteString(`</d:multistatus>`)
	return builder.String()
}

func fakeWebDAVResponse(href string, directory bool, size int) string {
	displayName := path.Base(strings.Trim(href, "/"))
	resourceType := `<d:resourcetype/>`
	if directory {
		resourceType = `<d:resourcetype><d:collection/></d:resourcetype>`
	}
	return `<d:response><d:href>` + href + `</d:href><d:propstat><d:prop><d:displayname>` + displayName + `</d:displayname>` + resourceType + `<d:getcontentlength>` + strconv.Itoa(size) + `</d:getcontentlength><d:getlastmodified>Wed, 10 Jun 2026 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
}
