package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestRenderWebhookPayloadTemplateEscapesMultilineContent(t *testing.T) {
	body, err := renderWebhookPayloadTemplate(`{"title":"{title}","content":"{content}","nested":["{timestamp}",{"copy":"{content}"}]}`, notificationMessage{
		Title:     "Renewlet",
		Content:   "即将续费：\n- GitHub：2026-08-01\n- Figma：2026-08-02",
		Timestamp: "2026-07-20 08:00 CST",
	}, localeZhCN)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("expected valid JSON body, got %q: %v", string(body), err)
	}
	if got := payload["content"]; got != "即将续费：\n- GitHub：2026-08-01\n- Figma：2026-08-02" {
		t.Fatalf("unexpected content %#v", got)
	}
	nested := payload["nested"].([]interface{})
	if nested[0] != "2026-07-20 08:00 CST" {
		t.Fatalf("unexpected nested timestamp %#v", nested)
	}
}

func TestRenderWebhookPayloadTemplateRejectsInvalidJSON(t *testing.T) {
	_, err := renderWebhookPayloadTemplate(`{"content": "{content}"`, notificationMessage{Content: "line\nline"}, localeZhCN)
	if err == nil {
		t.Fatal("expected invalid JSON template error")
	}
	if !strings.Contains(err.Error(), "JSON") {
		t.Fatalf("expected JSON parse error, got %q", err)
	}
}

func TestSignedDingTalkWebhookURLOverwritesTimestampAndSign(t *testing.T) {
	now := time.UnixMilli(1_774_225_234_567)
	got, err := signedDingTalkWebhookURL("https://oapi.dingtalk.com/robot/send?access_token=ding-token&timestamp=old&sign=old", "SECsecret", now)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	if query.Get("timestamp") != "1774225234567" {
		t.Fatalf("unexpected timestamp %q", query.Get("timestamp"))
	}
	mac := hmac.New(sha256.New, []byte("SECsecret"))
	_, _ = mac.Write([]byte("1774225234567\nSECsecret"))
	wantSign := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if query.Get("sign") != wantSign {
		t.Fatalf("unexpected sign %q, want %q", query.Get("sign"), wantSign)
	}
	if strings.Contains(got, "old") {
		t.Fatalf("expected old signature query to be overwritten, got %q", got)
	}
}

func TestSendDingTalkPostsMarkdownPayloadAndRequiresErrCodeZero(t *testing.T) {
	withSafeOutboundResolver(t)
	var gotURL string
	var gotPayload dingTalkMarkdownRequest
	restore := withNotificationHTTPClient(t, serverChanRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		gotURL = req.URL.String()
		if req.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", req.Method)
		}
		if err := json.NewDecoder(req.Body).Decode(&gotPayload); err != nil {
			t.Fatal(err)
		}
		return serverChanTestResponse(http.StatusOK, `{"errcode":0,"errmsg":"ok"}`), nil
	}))
	defer restore()

	settings := defaultAppSettings()
	settings.DingTalkWebhookURL = "https://oapi.dingtalk.com/robot/send?access_token=ding-token"
	settings.DingTalkKeyword = "Renewlet"
	err := sendDingTalk(settings, notificationMessage{
		Title:     "Renewlet 订阅提醒",
		Content:   "即将到期：\n- GitHub：2026-08-01",
		Timestamp: "2026-07-20 08:00 CST",
	}, defaultAppLocale)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(gotURL, "https://oapi.dingtalk.com/robot/send?access_token=ding-token") {
		t.Fatalf("unexpected DingTalk URL %q", gotURL)
	}
	if gotPayload.MsgType != "markdown" || gotPayload.Markdown.Title != "Renewlet 订阅提醒" {
		t.Fatalf("unexpected DingTalk payload %#v", gotPayload)
	}
	if !strings.Contains(gotPayload.Markdown.Text, "Renewlet") || !strings.Contains(gotPayload.Markdown.Text, "GitHub") {
		t.Fatalf("expected Renewlet marker and multiline content in payload, got %#v", gotPayload.Markdown.Text)
	}
}

func TestSendDingTalkAppliesTitleAndContentTemplates(t *testing.T) {
	withSafeOutboundResolver(t)
	var gotPayload dingTalkMarkdownRequest
	restore := withNotificationHTTPClient(t, serverChanRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		if err := json.NewDecoder(req.Body).Decode(&gotPayload); err != nil {
			t.Fatal(err)
		}
		return serverChanTestResponse(http.StatusOK, `{"errcode":0,"errmsg":"ok"}`), nil
	}))
	defer restore()

	settings := defaultAppSettings()
	settings.DingTalkWebhookURL = "https://oapi.dingtalk.com/robot/send?access_token=ding-token"
	settings.DingTalkKeyword = "安全词"
	settings.DingTalkTitleTemplate = "{brand} · {title} · {unknown}"
	settings.DingTalkContentTemplate = "{keyword}\n{title}\n{content}\n{timestamp}\n{itemCount}\n{unknown}"
	err := sendDingTalk(settings, notificationMessage{
		Title:     "订阅提醒",
		Content:   "即将到期：\n- GitHub：{timestamp}",
		Timestamp: "2026-07-20 08:00 CST",
		Items:     []notificationContentItem{{}, {}},
	}, defaultAppLocale)
	if err != nil {
		t.Fatal(err)
	}
	if gotPayload.Markdown.Title != "Renewlet · 订阅提醒 · {unknown}" {
		t.Fatalf("unexpected DingTalk title %#v", gotPayload.Markdown.Title)
	}
	if !strings.Contains(gotPayload.Markdown.Text, "安全词\n订阅提醒") || !strings.Contains(gotPayload.Markdown.Text, "2") {
		t.Fatalf("expected rendered DingTalk template to include variables, got %#v", gotPayload.Markdown.Text)
	}
	if strings.Count(gotPayload.Markdown.Text, "安全词") != 1 || !strings.HasSuffix(gotPayload.Markdown.Text, "\n\nRenewlet") {
		t.Fatalf("expected exact keyword to stay single and missing brand marker to be appended, got %#v", gotPayload.Markdown.Text)
	}
	if !strings.Contains(gotPayload.Markdown.Text, "{unknown}") {
		t.Fatalf("expected unknown template variable to stay literal, got %#v", gotPayload.Markdown.Text)
	}
	if !strings.Contains(gotPayload.Markdown.Text, "GitHub：{timestamp}") {
		t.Fatalf("expected placeholders inside message content to stay literal, got %#v", gotPayload.Markdown.Text)
	}
}

func TestSendDingTalkEmptyTemplatesKeepDefaultPayloadOrder(t *testing.T) {
	withSafeOutboundResolver(t)
	var gotPayload dingTalkTextRequest
	restore := withNotificationHTTPClient(t, serverChanRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		if err := json.NewDecoder(req.Body).Decode(&gotPayload); err != nil {
			t.Fatal(err)
		}
		return serverChanTestResponse(http.StatusOK, `{"errcode":0,"errmsg":"ok"}`), nil
	}))
	defer restore()

	settings := defaultAppSettings()
	settings.DingTalkWebhookURL = "https://oapi.dingtalk.com/robot/send?access_token=ding-token"
	settings.DingTalkMessageType = dingtalkMessageTypeText
	err := sendDingTalk(settings, notificationMessage{
		Title:     "订阅提醒",
		Content:   "即将到期：\n- GitHub：2026-08-01",
		Timestamp: "2026-07-20 08:00 CST",
	}, defaultAppLocale)
	if err != nil {
		t.Fatal(err)
	}
	want := "订阅提醒\n\n即将到期：\n- GitHub：2026-08-01\n\n2026-07-20 08:00 CST\n\nRenewlet"
	if gotPayload.Text.Content != want {
		t.Fatalf("expected default DingTalk content order with footer marker, got %#v", gotPayload.Text.Content)
	}
}

func TestEnsureDingTalkContentMarkersAppendsLowNoiseMarkers(t *testing.T) {
	tests := []struct {
		name    string
		content string
		keyword string
		want    string
	}{
		{
			name:    "lowercase keyword with existing brand stays at footer",
			content: "Renewlet 订阅提醒\n\n正文",
			keyword: "renewlet",
			want:    "Renewlet 订阅提醒\n\n正文\n\nrenewlet",
		},
		{
			name:    "exact brand keyword is not duplicated",
			content: "Renewlet 订阅提醒\n\n正文",
			keyword: "Renewlet",
			want:    "Renewlet 订阅提醒\n\n正文",
		},
		{
			name:    "existing custom keyword is not duplicated",
			content: "提醒\n\n安全词\n正文",
			keyword: "安全词",
			want:    "提醒\n\n安全词\n正文\n\nRenewlet",
		},
		{
			name:    "missing brand and keyword share one footer marker",
			content: "提醒\n\n正文",
			keyword: "自定义关键词",
			want:    "提醒\n\n正文\n\nRenewlet · 自定义关键词",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ensureDingTalkContentMarkers(tt.content, tt.keyword); got != tt.want {
				t.Fatalf("unexpected DingTalk markers:\nwant: %q\n got: %q", tt.want, got)
			}
		})
	}
}

func TestSendDingTalkSignsTextPayloadAndRedactsSecretsOnBusinessFailure(t *testing.T) {
	withSafeOutboundResolver(t)
	var gotURL string
	var gotPayload dingTalkTextRequest
	restore := withNotificationHTTPClient(t, serverChanRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		gotURL = req.URL.String()
		if err := json.NewDecoder(req.Body).Decode(&gotPayload); err != nil {
			t.Fatal(err)
		}
		return serverChanTestResponse(http.StatusOK, `{"errcode":310000,"errmsg":"keywords not in content SECsecret ding-token"}`), nil
	}))
	defer restore()

	settings := defaultAppSettings()
	settings.DingTalkWebhookURL = "https://oapi.dingtalk.com/robot/send?access_token=ding-token&timestamp=old&sign=old"
	settings.DingTalkSecret = "SECsecret"
	settings.DingTalkKeyword = "自定义关键词"
	settings.DingTalkMessageType = dingtalkMessageTypeText
	err := sendDingTalk(settings, notificationMessage{Title: "提醒", Content: "正文", Timestamp: "time"}, defaultAppLocale)
	if err == nil {
		t.Fatal("expected DingTalk business error")
	}
	if gotPayload.MsgType != "text" || !strings.HasSuffix(gotPayload.Text.Content, "\n\nRenewlet · 自定义关键词") {
		t.Fatalf("unexpected DingTalk text payload %#v", gotPayload)
	}
	if strings.Contains(gotURL, "old") || !strings.Contains(gotURL, "timestamp=") || !strings.Contains(gotURL, "sign=") {
		t.Fatalf("expected signed URL to overwrite old query, got %q", gotURL)
	}
	channelErr := notificationChannelErrorFrom(err)
	if channelErr == nil || channelErr.details == nil || channelErr.details.RawResponseText == nil {
		t.Fatalf("expected upstream details, got %#v", err)
	}
	for _, forbidden := range []string{"SECsecret", "ding-token"} {
		if strings.Contains(err.Error(), forbidden) || strings.Contains(*channelErr.details.RawResponseText, forbidden) {
			t.Fatalf("DingTalk error leaked %q: %q %#v", forbidden, err.Error(), *channelErr.details.RawResponseText)
		}
	}
	if !strings.Contains(err.Error(), "310000") || !strings.Contains(*channelErr.details.RawResponseText, "[redacted]") {
		t.Fatalf("expected errcode and redacted details, got %q %#v", err.Error(), *channelErr.details.RawResponseText)
	}
}

func TestRequireDingTalkSuccessFailsBusinessCodes(t *testing.T) {
	for _, body := range []string{
		`{"errcode":410100,"errmsg":"too many requests"}`,
		`{"errcode":40035,"errmsg":"缺少参数 json"}`,
		`{"errcode":400105,"errmsg":"不支持的 msgtype"}`,
	} {
		err := requireDingTalkSuccess(serverChanTestResponse(http.StatusOK, body), localeZhCN, "ding-token")
		if err == nil {
			t.Fatalf("expected DingTalk body %s to fail", body)
		}
		if !strings.Contains(err.Error(), "DingTalk") || !strings.Contains(err.Error(), "errcode=") {
			t.Fatalf("unexpected DingTalk error %q", err)
		}
	}
}

func withSafeOutboundResolver(t *testing.T) {
	t.Helper()
	previous := outboundURLResolver
	outboundURLResolver = func(_ string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}, nil
	}
	t.Cleanup(func() {
		outboundURLResolver = previous
	})
}
