package main

// Server酱通知测试保护官方请求形状和失败响应解析。
// 这个渠道是外部 HTTP 发送边界，测试必须避免真实网络，同时覆盖 sendkey 缺失与 provider 错误文本。
import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type serverChanRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn serverChanRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestBuildServerChanEndpoint(t *testing.T) {
	cases := []struct {
		name    string
		sendKey string
		want    string
		wantErr bool
	}{
		{name: "turbo", sendKey: "SCT123456", want: "https://sctapi.ftqq.com/SCT123456.send"},
		{name: "turbo escapes path", sendKey: "SCT key", want: "https://sctapi.ftqq.com/SCT%20key.send"},
		{name: "sctp", sendKey: "sctp123tabcdef", want: "https://123.push.ft07.com/send/sctp123tabcdef.send"},
		{name: "invalid sctp", sendKey: "sctpabcdef", wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := buildServerChanEndpoint(tc.sendKey, localeZhCN)
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error")
				}
				if !strings.Contains(err.Error(), "SendKey") {
					t.Fatalf("expected SendKey format error, got %q", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("unexpected endpoint %q", got)
			}
		})
	}
}

func TestSendServerChanRequiresSendKey(t *testing.T) {
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceZhCN)
	err := sendServerChan(settings, notificationMessage{Title: "title", Content: "content", Timestamp: "time"}, accountContentLocale(settings))
	if err == nil {
		t.Fatal("expected missing SendKey error")
	}
	if !strings.Contains(err.Error(), "Server酱 SendKey") {
		t.Fatalf("unexpected error %q", err)
	}
}

func TestSendServerChanPostsOfficialPayload(t *testing.T) {
	var gotURL string
	var gotBody serverChanSendRequest
	restore := withNotificationHTTPClient(t, serverChanRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		gotURL = req.URL.String()
		if req.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", req.Method)
		}
		if got := req.Header.Get("content-type"); got != "application/json" {
			t.Fatalf("expected JSON content type, got %q", got)
		}
		if err := json.NewDecoder(req.Body).Decode(&gotBody); err != nil {
			t.Fatal(err)
		}
		return serverChanTestResponse(http.StatusOK, `{"code":0,"message":"ok"}`), nil
	}))
	defer restore()

	settings := defaultAppSettings()
	settings.ServerChanSendKey = "sctp456tabcdef"
	err := sendServerChan(settings, notificationMessage{
		Title:     "Renewlet 测试通知",
		Content:   "如果你收到了这条消息，说明该通知渠道配置可用。",
		Timestamp: "2026-05-14 08:00 UTC",
	}, localeZhCN)
	if err != nil {
		t.Fatal(err)
	}
	if gotURL != "https://456.push.ft07.com/send/sctp456tabcdef.send" {
		t.Fatalf("unexpected request URL %q", gotURL)
	}
	if gotBody.Title != "Renewlet 测试通知" {
		t.Fatalf("unexpected title %q", gotBody.Title)
	}
	if gotBody.Desp != "如果你收到了这条消息，说明该通知渠道配置可用。\n\n2026-05-14 08:00 UTC" {
		t.Fatalf("unexpected desp %q", gotBody.Desp)
	}
}

func TestRequireServerChanSuccessHandlesFailures(t *testing.T) {
	cases := []struct {
		name             string
		statusCode       int
		body             string
		want             string
		wantBodyContains string
	}{
		{name: "http failure json", statusCode: http.StatusBadRequest, body: `{"code":40001,"message":"bad sendkey"}`, want: "bad sendkey", wantBodyContains: "bad sendkey"},
		{name: "business failure", statusCode: http.StatusOK, body: `{"code":40001,"detail":"quota exhausted"}`, want: "quota exhausted", wantBodyContains: "quota exhausted"},
		{name: "redacts sendkey", statusCode: http.StatusOK, body: `{"code":40001,"message":"SCTsecret disabled"}`, want: "[redacted] disabled", wantBodyContains: "[redacted] disabled"},
		{name: "http failure invalid json", statusCode: http.StatusBadGateway, body: `upstream returned SCTsecret`, want: "upstream returned [redacted]", wantBodyContains: "upstream returned [redacted]"},
		{name: "invalid json", statusCode: http.StatusOK, body: `not-json`, want: "not-json", wantBodyContains: "not-json"},
		{name: "missing code", statusCode: http.StatusOK, body: `{"message":"ok"}`, want: "Server酱响应格式无效", wantBodyContains: `"message":"ok"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := requireServerChanSuccess(serverChanTestResponse(tc.statusCode, tc.body), localeZhCN, "SCTsecret")
			if err == nil {
				t.Fatal("expected error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected error to contain %q, got %q", tc.want, err)
			}
			if strings.Contains(err.Error(), "SCTsecret") {
				t.Fatalf("error leaked SendKey: %q", err)
			}
			channelErr := notificationChannelErrorFrom(err)
			if channelErr == nil || channelErr.details == nil || channelErr.details.RawResponseText == nil {
				t.Fatalf("expected upstream details, got %#v", err)
			}
			if !strings.Contains(*channelErr.details.RawResponseText, tc.wantBodyContains) {
				t.Fatalf("expected upstream body to contain %q, got %#v", tc.wantBodyContains, channelErr.details.RawResponseText)
			}
			if strings.Contains(*channelErr.details.RawResponseText, "SCTsecret") {
				t.Fatalf("provider response leaked SendKey: %q", *channelErr.details.RawResponseText)
			}
		})
	}
}

func TestRequireServerChanSuccessAcceptsCodeZero(t *testing.T) {
	err := requireServerChanSuccess(serverChanTestResponse(http.StatusOK, `{"code":0,"message":"ok"}`), localeZhCN, "SCTsecret")
	if err != nil {
		t.Fatal(err)
	}
}

func withNotificationHTTPClient(t *testing.T, transport http.RoundTripper) func() {
	t.Helper()
	previous := notificationHTTPClientFactory
	notificationHTTPClientFactory = func() *http.Client {
		return &http.Client{Transport: transport}
	}
	return func() {
		notificationHTTPClientFactory = previous
	}
}

func serverChanTestResponse(statusCode int, body string) *http.Response {
	return &http.Response{
		StatusCode: statusCode,
		Status:     http.StatusText(statusCode),
		Body:       io.NopCloser(bytes.NewBufferString(body)),
		Header:     make(http.Header),
	}
}
