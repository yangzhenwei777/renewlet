package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

type telegramBotAPITestCall struct {
	Token   string
	Method  string
	Payload json.RawMessage
}

func TestTelegramBotExternalOriginUsesPublicLinkOriginForLocalAppURL(t *testing.T) {
	t.Setenv("APP_URL", "http://localhost:3000")
	request, err := http.NewRequest(http.MethodPost, "http://127.0.0.1:3000/api/app/telegram-bot/commands", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Forwarded-Proto", "https")
	request.Header.Set("X-Forwarded-Host", "renewlet.example.com")

	origin, err := telegramBotExternalOrigin(request)
	if err != nil {
		t.Fatal(err)
	}
	if got := origin.String(); got != "https://renewlet.example.com" {
		t.Fatalf("telegramBotExternalOrigin() = %q, want https://renewlet.example.com", got)
	}
}

func TestTelegramBotExternalOriginKeepsExplicitPublicAppURL(t *testing.T) {
	t.Setenv("APP_URL", "https://configured.example.com/app?ignored=true")
	request, err := http.NewRequest(http.MethodPost, "http://127.0.0.1:3000/api/app/telegram-bot/commands", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Forwarded", `proto=https;host=forwarded.example.com`)

	origin, err := telegramBotExternalOrigin(request)
	if err != nil {
		t.Fatal(err)
	}
	if got := origin.String(); got != "https://configured.example.com" {
		t.Fatalf("telegramBotExternalOrigin() = %q, want https://configured.example.com", got)
	}
}

func TestTelegramBotExternalOriginKeepsExplicitHTTPPublicAppURLForHTTPSGate(t *testing.T) {
	t.Setenv("APP_URL", "http://configured.example.com")
	request, err := http.NewRequest(http.MethodPost, "http://127.0.0.1:3000/api/app/telegram-bot/commands", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Forwarded-Proto", "https")
	request.Header.Set("X-Forwarded-Host", "forwarded.example.com")

	origin, err := telegramBotExternalOrigin(request)
	if err != nil {
		t.Fatal(err)
	}
	if got := origin.String(); got != "http://configured.example.com" {
		t.Fatalf("telegramBotExternalOrigin() = %q, want http://configured.example.com", got)
	}
}

func TestTelegramBotCommandsInstallWebhookAndDelete(t *testing.T) {
	t.Setenv("APP_URL", "http://localhost:3000")
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, sessionToken := createRouteTestUser(t, app, "telegram")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceZhCN)
	settings.Timezone = "UTC"
	settings.TelegramBotToken = "123456:telegram-secret-token"
	settings.TelegramChatID = "12345"
	createCalendarFeedTestSettings(t, app, user, settings)
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":            "Active Plan",
		"status":          "active",
		"nextBillingDate": addDateOnly(todayDateOnly(time.Now().UTC(), "UTC"), 5),
	})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":            "Trial Plan",
		"status":          "trial",
		"trialEndDate":    addDateOnly(todayDateOnly(time.Now().UTC(), "UTC"), 3),
		"nextBillingDate": addDateOnly(todayDateOnly(time.Now().UTC(), "UTC"), 40),
	})
	calls := captureTelegramBotAPICalls(t, nil)

	statusRes := serveTestRequest(t, app, http.MethodGet, "/api/app/telegram-bot/commands", "", sessionToken)
	if statusRes.Code != http.StatusOK || !strings.Contains(statusRes.Body.String(), `"status":"not_installed"`) {
		t.Fatalf("expected not installed status, got %d: %s", statusRes.Code, statusRes.Body.String())
	}

	invalidBodyRes := serveTestRequest(t, app, http.MethodPost, "/api/app/telegram-bot/commands", `{}`, sessionToken)
	if invalidBodyRes.Code != http.StatusBadRequest {
		t.Fatalf("expected install to reject non-empty body, got %d: %s", invalidBodyRes.Code, invalidBodyRes.Body.String())
	}
	httpOriginRes := serveTestRequest(t, app, http.MethodPost, "/api/app/telegram-bot/commands", "", sessionToken)
	if httpOriginRes.Code != http.StatusBadRequest || !strings.Contains(httpOriginRes.Body.String(), "TELEGRAM_BOT_HTTPS_REQUIRED") {
		t.Fatalf("expected install to require https origin, got %d: %s", httpOriginRes.Code, httpOriginRes.Body.String())
	}

	installRes := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/app/telegram-bot/commands", "", sessionToken, map[string]string{
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host":  "renewlet.example.com",
	})
	if installRes.Code != http.StatusOK {
		t.Fatalf("expected install 200, got %d: %s", installRes.Code, installRes.Body.String())
	}
	if strings.Contains(installRes.Body.String(), settings.TelegramBotToken) || strings.Contains(installRes.Body.String(), "webhookSecretHash") {
		t.Fatalf("install response leaked secret material: %s", installRes.Body.String())
	}
	installBody := decodeAPISuccessDataForTest[telegramBotCommandsResponse](t, installRes.Body.Bytes())
	if !installBody.Installed || installBody.Status != "installed" {
		t.Fatalf("unexpected install response: %#v", installBody)
	}
	if strings.Contains(installRes.Body.String(), "commandsVersion") {
		t.Fatalf("install response leaked removed commandsVersion field: %s", installRes.Body.String())
	}
	if len(*calls) != 2 || (*calls)[0].Method != telegramBotAPIMethodSetWebhook || (*calls)[1].Method != telegramBotAPIMethodSetCommands {
		t.Fatalf("unexpected install API calls: %#v", *calls)
	}
	var setWebhook telegramBotSetWebhookRequest
	if err := json.Unmarshal((*calls)[0].Payload, &setWebhook); err != nil {
		t.Fatal(err)
	}
	if setWebhook.URL == "" || !strings.HasPrefix(setWebhook.URL, "https://renewlet.example.com/api/telegram/webhook/") {
		t.Fatalf("unexpected webhook URL: %#v", setWebhook)
	}
	if len(setWebhook.AllowedUpdates) != 1 || setWebhook.AllowedUpdates[0] != "message" || !setWebhook.DropPendingUpdates || setWebhook.MaxConnections != 1 || setWebhook.SecretToken == "" {
		t.Fatalf("unexpected setWebhook payload: %#v", setWebhook)
	}
	var setCommands telegramBotSetMyCommandsRequest
	if err := json.Unmarshal((*calls)[1].Payload, &setCommands); err != nil {
		t.Fatal(err)
	}
	if setCommands.Scope.Type != "chat" || setCommands.Scope.ChatID != settings.TelegramChatID || len(setCommands.Commands) != 9 {
		t.Fatalf("unexpected setMyCommands payload: %#v", setCommands)
	}
	if !telegramBotTestHasCommand(setCommands.Commands, "next") || !telegramBotTestHasCommand(setCommands.Commands, "month") || telegramBotTestHasCommand(setCommands.Commands, "due") {
		t.Fatalf("unexpected command menu: %#v", setCommands.Commands)
	}
	if !telegramBotTestHasCommandDescription(setCommands.Commands, "status", "查看订阅状态摘要") {
		t.Fatalf("expected zh-CN status command description, got %#v", setCommands.Commands)
	}
	if strings.Contains(string((*calls)[1].Payload), "language_code") {
		t.Fatalf("chat-scoped menu must not set Telegram language_code: %s", string((*calls)[1].Payload))
	}

	binding := telegramBotTestBinding(t, app, user.Id)
	if binding.GetString("botTokenHash") == settings.TelegramBotToken || binding.GetString("webhookSecretHash") == setWebhook.SecretToken {
		t.Fatalf("binding must only store hashes: bot=%q secret=%q", binding.GetString("botTokenHash"), binding.GetString("webhookSecretHash"))
	}
	mismatchedSettings := settings
	mismatchedSettings.TelegramBotToken = "123456:another-token"
	mismatchedDTO := telegramBotCommandsDTO(mismatchedSettings, binding)
	if mismatchedDTO.Installed || mismatchedDTO.Status != "not_installed" {
		t.Fatalf("mismatched binding should not be exposed as installed: %#v", mismatchedDTO)
	}

	settingsChangeRes := serveTestRequest(t, app, http.MethodPut, "/api/app/settings", `{"telegramChatId":"99999"}`, sessionToken)
	if settingsChangeRes.Code != http.StatusBadRequest {
		t.Fatalf("expected installed command to block chat id changes, got %d: %s", settingsChangeRes.Code, settingsChangeRes.Body.String())
	}

	badSecretRes := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/telegram/webhook/"+binding.Id, `{"update_id":1,"message":{"chat":{"id":12345},"text":"/status"}}`, "", map[string]string{
		telegramWebhookSecretHeader: "wrong-secret",
	})
	if badSecretRes.Code != http.StatusUnauthorized {
		t.Fatalf("expected bad webhook secret 401, got %d: %s", badSecretRes.Code, badSecretRes.Body.String())
	}

	statusWebhookRes := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/telegram/webhook/"+binding.Id, `{"update_id":1,"message":{"chat":{"id":12345},"text":"/status"}}`, "", map[string]string{
		telegramWebhookSecretHeader: setWebhook.SecretToken,
	})
	if statusWebhookRes.Code != http.StatusOK {
		t.Fatalf("expected webhook 200, got %d: %s", statusWebhookRes.Code, statusWebhookRes.Body.String())
	}
	if len(*calls) != 3 || (*calls)[2].Method != telegramBotAPIMethodSendMessage {
		t.Fatalf("expected status command to send one message, calls=%#v", *calls)
	}
	var statusMessage telegramSendMessageRequest
	if err := json.Unmarshal((*calls)[2].Payload, &statusMessage); err != nil {
		t.Fatal(err)
	}
	if statusMessage.ChatID != settings.TelegramChatID || !strings.Contains(statusMessage.Text, "总数：2") || statusMessage.LinkPreviewOptions == nil || !statusMessage.LinkPreviewOptions.IsDisabled {
		t.Fatalf("unexpected status reply: %#v", statusMessage)
	}
	if statusMessage.ParseMode != "" {
		t.Fatalf("plain Telegram replies must not set parse_mode, got %q", statusMessage.ParseMode)
	}
	binding = telegramBotTestBinding(t, app, user.Id)
	if binding.GetInt("lastUpdateId") != 1 || binding.GetString("lastUsedAt") == "" {
		t.Fatalf("status command should mark update as used, lastUpdateId=%d lastUsedAt=%q", binding.GetInt("lastUpdateId"), binding.GetString("lastUsedAt"))
	}

	duplicateRes := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/telegram/webhook/"+binding.Id, `{"update_id":1,"message":{"chat":{"id":12345},"text":"/status"}}`, "", map[string]string{
		telegramWebhookSecretHeader: setWebhook.SecretToken,
	})
	if duplicateRes.Code != http.StatusOK || len(*calls) != 3 {
		t.Fatalf("duplicate update should be a no-op, code=%d calls=%#v", duplicateRes.Code, *calls)
	}
	foreignChatRes := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/telegram/webhook/"+binding.Id, `{"update_id":2,"message":{"chat":{"id":99999},"text":"/subscriptions"}}`, "", map[string]string{
		telegramWebhookSecretHeader: setWebhook.SecretToken,
	})
	if foreignChatRes.Code != http.StatusOK || len(*calls) != 3 {
		t.Fatalf("foreign chat should be a no-op, code=%d calls=%#v", foreignChatRes.Code, *calls)
	}
	if got := telegramBotTestBinding(t, app, user.Id).GetInt("lastUpdateId"); got != 1 {
		t.Fatalf("foreign chat should not advance lastUpdateId, got %d", got)
	}
	nonCommandRes := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/telegram/webhook/"+binding.Id, `{"update_id":2,"message":{"chat":{"id":12345},"text":"hello"}}`, "", map[string]string{
		telegramWebhookSecretHeader: setWebhook.SecretToken,
	})
	if nonCommandRes.Code != http.StatusOK || len(*calls) != 3 {
		t.Fatalf("non-command message should be a no-op, code=%d calls=%#v", nonCommandRes.Code, *calls)
	}
	if got := telegramBotTestBinding(t, app, user.Id).GetInt("lastUpdateId"); got != 1 {
		t.Fatalf("non-command message should not advance lastUpdateId, got %d", got)
	}
	subscriptionsRes := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/telegram/webhook/"+binding.Id, `{"update_id":3,"message":{"chat":{"id":12345},"text":"/subscriptions"}}`, "", map[string]string{
		telegramWebhookSecretHeader: setWebhook.SecretToken,
	})
	if subscriptionsRes.Code != http.StatusOK || len(*calls) != 4 {
		t.Fatalf("expected subscriptions command reply, code=%d calls=%#v", subscriptionsRes.Code, *calls)
	}
	var subscriptionsMessage telegramSendMessageRequest
	if err := json.Unmarshal((*calls)[3].Payload, &subscriptionsMessage); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(subscriptionsMessage.Text, "Active Plan") || strings.Contains(subscriptionsMessage.Text, "user") {
		t.Fatalf("unexpected subscriptions reply: %q", subscriptionsMessage.Text)
	}
	if got := telegramBotTestBinding(t, app, user.Id).GetInt("lastUpdateId"); got != 3 {
		t.Fatalf("target command should advance lastUpdateId, got %d", got)
	}

	deleteRes := serveTestRequest(t, app, http.MethodDelete, "/api/app/telegram-bot/commands", "", sessionToken)
	if deleteRes.Code != http.StatusOK {
		t.Fatalf("expected delete 200, got %d: %s", deleteRes.Code, deleteRes.Body.String())
	}
	if len(*calls) != 6 || (*calls)[4].Method != telegramBotAPIMethodDeleteHook || (*calls)[5].Method != telegramBotAPIMethodDelCommands {
		t.Fatalf("unexpected delete API calls: %#v", *calls)
	}
	if _, err := findTelegramBotBindingForUser(app, user.Id); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("expected binding to be hard deleted, err=%v", err)
	}
}

func TestTelegramBotHTMLRepliesEscapeUserContent(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, sessionToken := createRouteTestUser(t, app, "telegram-html")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceZhCN)
	settings.Timezone = "UTC"
	settings.TelegramBotToken = "123456:telegram-secret-token"
	settings.TelegramChatID = "12345"
	settings.TelegramMessageFormat = telegramMessageFormatHTML
	createCalendarFeedTestSettings(t, app, user, settings)
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":            `A&B <Pro> "Plan"`,
		"status":          "active",
		"nextBillingDate": addDateOnly(todayDateOnly(time.Now().UTC(), "UTC"), 5),
	})
	calls := captureTelegramBotAPICalls(t, nil)

	installRes := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/app/telegram-bot/commands", "", sessionToken, map[string]string{
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host":  "renewlet.example.com",
	})
	if installRes.Code != http.StatusOK {
		t.Fatalf("expected install 200, got %d: %s", installRes.Code, installRes.Body.String())
	}
	var setWebhook telegramBotSetWebhookRequest
	if err := json.Unmarshal((*calls)[0].Payload, &setWebhook); err != nil {
		t.Fatal(err)
	}
	binding := telegramBotTestBinding(t, app, user.Id)

	res := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/telegram/webhook/"+binding.Id, `{"update_id":1,"message":{"chat":{"id":12345},"text":"/subscriptions"}}`, "", map[string]string{
		telegramWebhookSecretHeader: setWebhook.SecretToken,
	})
	if res.Code != http.StatusOK || len(*calls) != 3 {
		t.Fatalf("expected html subscriptions reply, code=%d calls=%#v", res.Code, *calls)
	}
	var message telegramSendMessageRequest
	if err := json.Unmarshal((*calls)[2].Payload, &message); err != nil {
		t.Fatal(err)
	}
	if message.ParseMode != "HTML" {
		t.Fatalf("expected HTML parse mode, got %#v", message)
	}
	if !strings.Contains(message.Text, `A&amp;B &lt;Pro&gt; &#34;Plan&#34;`) || strings.Contains(message.Text, `<Pro>`) {
		t.Fatalf("html reply did not escape subscription name: %q", message.Text)
	}
	statusRes := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/telegram/webhook/"+binding.Id, `{"update_id":2,"message":{"chat":{"id":12345},"text":"/status"}}`, "", map[string]string{
		telegramWebhookSecretHeader: setWebhook.SecretToken,
	})
	if statusRes.Code != http.StatusOK || len(*calls) != 4 {
		t.Fatalf("expected html status reply, code=%d calls=%#v", statusRes.Code, *calls)
	}
	var statusMessage telegramSendMessageRequest
	if err := json.Unmarshal((*calls)[3].Payload, &statusMessage); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(statusMessage.Text, `总数：<b>1</b>`) {
		t.Fatalf("html status reply should emphasize zh-CN count line: %q", statusMessage.Text)
	}
}

func TestTelegramBotInstallFailureCleansLocalBinding(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, sessionToken := createRouteTestUser(t, app, "telegram-fail")
	settings := defaultAppSettings()
	settings.TelegramBotToken = "123456:telegram-secret-token"
	settings.TelegramChatID = "12345"
	createCalendarFeedTestSettings(t, app, user, settings)
	calls := captureTelegramBotAPICalls(t, func(method string) error {
		if method == telegramBotAPIMethodSetCommands {
			return newNotificationChannelError("telegram failed", &upstreamErrorDetails{RawResponseText: stringPointer("failed")})
		}
		return nil
	})

	res := serveTestRequestWithHeaders(t, app, http.MethodPost, "/api/app/telegram-bot/commands", "", sessionToken, map[string]string{
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host":  "renewlet.example.com",
	})
	if res.Code != http.StatusBadGateway || !strings.Contains(res.Body.String(), "TELEGRAM_API_FAILED") {
		t.Fatalf("expected sanitized Telegram API failure, got %d: %s", res.Code, res.Body.String())
	}
	if _, err := findTelegramBotBindingForUser(app, user.Id); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("failed install should delete local binding, err=%v", err)
	}
	if len(*calls) != 4 || (*calls)[2].Method != telegramBotAPIMethodDeleteHook || (*calls)[3].Method != telegramBotAPIMethodDelCommands {
		t.Fatalf("failed install should best-effort clean remote state, calls=%#v", *calls)
	}
}

func TestTelegramBotDueDaysStrictParsing(t *testing.T) {
	if got := telegramBotDueDays("30abc"); got != telegramBotCommandDueDefault {
		t.Fatalf("expected invalid mixed due days to use default, got %d", got)
	}
	if got := telegramBotDueDays("367"); got != telegramBotCommandDueMax {
		t.Fatalf("expected due days to clamp to max, got %d", got)
	}
}

func captureTelegramBotAPICalls(t *testing.T, fail func(method string) error) *[]telegramBotAPITestCall {
	t.Helper()
	old := telegramBotPostJSON
	calls := []telegramBotAPITestCall{}
	telegramBotPostJSON = func(token string, method string, payload interface{}, locale appLocale, secrets ...string) error {
		data, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		calls = append(calls, telegramBotAPITestCall{Token: token, Method: method, Payload: data})
		if fail != nil {
			return fail(method)
		}
		return nil
	}
	t.Cleanup(func() {
		telegramBotPostJSON = old
	})
	return &calls
}

func telegramBotTestBinding(t *testing.T, app core.App, userID string) *core.Record {
	t.Helper()
	binding, err := findTelegramBotBindingForUser(app, userID)
	if err != nil {
		t.Fatal(err)
	}
	return binding
}

func telegramBotTestHasCommand(commands []telegramBotCommand, command string) bool {
	for _, item := range commands {
		if item.Command == command {
			return true
		}
	}
	return false
}

func telegramBotTestHasCommandDescription(commands []telegramBotCommand, command string, description string) bool {
	for _, item := range commands {
		if item.Command == command && item.Description == description {
			return true
		}
	}
	return false
}

func stringPointer(value string) *string {
	return &value
}
