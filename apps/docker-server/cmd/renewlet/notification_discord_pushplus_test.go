package main

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDiscordWebhookEndpointRequiresOfficialURLAndWait(t *testing.T) {
	endpoint, err := discordWebhookEndpoint("https://discord.com/api/webhooks/123/token?thread_id=456", localeZhCN)
	if err != nil {
		t.Fatal(err)
	}
	if endpoint != "https://discord.com/api/webhooks/123/token?thread_id=456&wait=true" {
		t.Fatalf("unexpected endpoint %q", endpoint)
	}
	for _, rawURL := range []string{
		"http://discord.com/api/webhooks/123/token",
		"https://discordapp.com/api/webhooks/123/token",
		"https://discord.com.evil.example/api/webhooks/123/token",
		"https://discord.com/api/webhooks/123",
	} {
		if _, err := discordWebhookEndpoint(rawURL, localeZhCN); err == nil {
			t.Fatalf("expected %q to be rejected", rawURL)
		}
	}
}

func TestDefaultNotificationHTTPClientKeepsProxyAndTLSPolicy(t *testing.T) {
	client := defaultNotificationHTTPClient()
	if client.Timeout != 10*time.Second {
		t.Fatalf("unexpected timeout %s", client.Timeout)
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", client.Transport)
	}
	if transport.Proxy == nil {
		t.Fatal("expected environment proxy function")
	}
	if reflect.ValueOf(transport.Proxy).Pointer() != reflect.ValueOf(http.ProxyFromEnvironment).Pointer() {
		t.Fatal("expected notification HTTP client to preserve http.ProxyFromEnvironment")
	}
	if transport.TLSClientConfig == nil || transport.TLSClientConfig.MinVersion != tls.VersionTLS12 {
		t.Fatalf("expected TLS 1.2 minimum, got %#v", transport.TLSClientConfig)
	}
}

func TestSendDiscordPostsAllowedMentionsAndTruncatesContent(t *testing.T) {
	var gotURL string
	var gotPayload discordWebhookRequest
	restore := withNotificationHTTPClient(t, serverChanRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		gotURL = req.URL.String()
		if req.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", req.Method)
		}
		if err := json.NewDecoder(req.Body).Decode(&gotPayload); err != nil {
			t.Fatal(err)
		}
		return serverChanTestResponse(http.StatusOK, `{"id":"msg"}`), nil
	}))
	defer restore()

	settings := defaultAppSettings()
	settings.DiscordWebhookURL = "https://discord.com/api/webhooks/123/super-secret"
	settings.DiscordBotUsername = "Renewlet"
	settings.DiscordBotAvatarURL = "https://cdn.example.com/avatar.png"
	err := sendDiscord(settings, notificationMessage{
		Title:     "Renewlet",
		Content:   strings.Repeat("订", 2100) + "@everyone",
		Timestamp: "2026-06-23 08:00 UTC",
	}, defaultAppLocale)
	if err != nil {
		t.Fatal(err)
	}
	if gotURL != "https://discord.com/api/webhooks/123/super-secret?wait=true" {
		t.Fatalf("unexpected Discord URL %q", gotURL)
	}
	if len([]rune(gotPayload.Content)) != discordContentMaxRunes {
		t.Fatalf("expected Discord content to be truncated to %d runes, got %d", discordContentMaxRunes, len([]rune(gotPayload.Content)))
	}
	if len(gotPayload.AllowedMentions.Parse) != 0 {
		t.Fatalf("expected allowed_mentions.parse to stay empty, got %#v", gotPayload.AllowedMentions.Parse)
	}
	if gotPayload.Username != "Renewlet" || gotPayload.AvatarURL != "https://cdn.example.com/avatar.png" {
		t.Fatalf("unexpected optional Discord fields: %#v", gotPayload)
	}
}

func TestSendDiscordTransportErrorDiagnosticRedactsWebhookTarget(t *testing.T) {
	restore := withNotificationHTTPClient(t, serverChanRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		return nil, errors.New("Network connection lost for " + req.URL.String() + " and super-secret")
	}))
	defer restore()

	settings := defaultAppSettings()
	settings.DiscordWebhookURL = "https://discord.com/api/webhooks/123/super-secret"
	err := sendDiscord(settings, notificationMessage{Title: "title", Content: "content", Timestamp: "time"}, defaultAppLocale)
	if err == nil {
		t.Fatal("expected Discord transport error")
	}
	channelErr := notificationChannelErrorFrom(err)
	if channelErr == nil || channelErr.details == nil || channelErr.details.RawResponseText == nil {
		t.Fatalf("expected upstream details, got %#v", err)
	}
	raw := *channelErr.details.RawResponseText
	for _, want := range []string{
		"Discord POST request to https://discord.com/api/webhooks/123/[redacted]?wait=true failed before response headers",
		"Network connection lost for https://discord.com/api/webhooks/123/[redacted]?wait=true and [redacted]",
		`"content-type":"application/json"`,
		`"allowed_mentions":{"parse":[]}`,
	} {
		if !strings.Contains(raw, want) {
			t.Fatalf("expected raw response text to contain %q, got %q", want, raw)
		}
	}
	for _, forbidden := range []string{"super-secret"} {
		if strings.Contains(raw, forbidden) || strings.Contains(err.Error(), forbidden) {
			t.Fatalf("Discord transport error leaked %q: %q %#v", forbidden, err.Error(), raw)
		}
	}
}

func TestSendPushPlusPostsOfficialPayloadAndRequiresCode200(t *testing.T) {
	var gotURL string
	var gotPayload pushPlusSendRequest
	restore := withNotificationHTTPClient(t, serverChanRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		gotURL = req.URL.String()
		if req.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", req.Method)
		}
		if err := json.NewDecoder(req.Body).Decode(&gotPayload); err != nil {
			t.Fatal(err)
		}
		return serverChanTestResponse(http.StatusOK, `{"code":200,"msg":"请求成功","data":"ok"}`), nil
	}))
	defer restore()

	settings := defaultAppSettings()
	settings.PushPlusToken = "push-token"
	err := sendPushPlus(settings, notificationMessage{Title: "title", Content: "content", Timestamp: "time"}, defaultAppLocale)
	if err != nil {
		t.Fatal(err)
	}
	if gotURL != "https://www.pushplus.plus/send" {
		t.Fatalf("unexpected PushPlus URL %q", gotURL)
	}
	if gotPayload.Token != "push-token" || gotPayload.Title != "title" || gotPayload.Content != "content\n\ntime" || gotPayload.Template != "txt" {
		t.Fatalf("unexpected PushPlus payload %#v", gotPayload)
	}
}

func TestSendPushPlusFailsBusinessCodeOnceAndRedactsToken(t *testing.T) {
	calls := 0
	restore := withNotificationHTTPClient(t, serverChanRoundTripFunc(func(_ *http.Request) (*http.Response, error) {
		calls++
		return serverChanTestResponse(http.StatusOK, `{"code":900,"msg":"push-token invalid"}`), nil
	}))
	defer restore()

	settings := defaultAppSettings()
	settings.PushPlusToken = "push-token"
	err := sendPushPlus(settings, notificationMessage{Title: "title", Content: "content", Timestamp: "time"}, defaultAppLocale)
	if err == nil {
		t.Fatal("expected PushPlus business code failure")
	}
	if calls != 1 {
		t.Fatalf("expected no channel-internal retry, got %d calls", calls)
	}
	channelErr := notificationChannelErrorFrom(err)
	if channelErr == nil || channelErr.details == nil || channelErr.details.RawResponseText == nil {
		t.Fatalf("expected upstream details, got %#v", err)
	}
	if strings.Contains(err.Error(), "push-token") || strings.Contains(*channelErr.details.RawResponseText, "push-token") {
		t.Fatalf("PushPlus token leaked in error/details: %q %#v", err.Error(), *channelErr.details.RawResponseText)
	}
	if !strings.Contains(*channelErr.details.RawResponseText, "[redacted] invalid") {
		t.Fatalf("expected redacted raw response, got %q", *channelErr.details.RawResponseText)
	}
}
