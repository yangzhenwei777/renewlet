package main

import (
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
)

func TestSettingsSecretsAreWriteOnly(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "settings-secret-api")

	update := serveTestRequest(t, app, http.MethodPut, "/api/app/settings", `{"secretUpdates":{"telegramBotToken":{"action":"set","value":"stored-telegram-secret"},"aiRecognition.apiKey":{"action":"set","value":"stored-ai-secret"}}}`, token)
	if update.Code != http.StatusOK {
		t.Fatalf("expected secret update 200, got %d: %s", update.Code, update.Body.String())
	}
	if strings.Contains(update.Body.String(), "stored-telegram-secret") || strings.Contains(update.Body.String(), "stored-ai-secret") {
		t.Fatalf("settings response leaked secret: %s", update.Body.String())
	}
	updateBody := decodeAPISuccessDataForTest[settingsResponse](t, update.Body.Bytes())
	if !updateBody.SecretStatus["telegramBotToken"].Configured || !updateBody.SecretStatus[aiRecognitionAPIKeySecret].Configured {
		t.Fatalf("expected configured secret status, got %#v", updateBody.SecretStatus)
	}
	record, err := app.FindFirstRecordByFilter("settings", "user = {:user}", dbx.Params{"user": user.Id})
	if err != nil {
		t.Fatal(err)
	}
	stored := mustSettingsFromRecord(t, record)
	if stored.TelegramBotToken != "stored-telegram-secret" || stored.AIRecognition.APIKey != "stored-ai-secret" {
		t.Fatalf("secret mutations were not persisted: %#v", stored)
	}

	read := serveTestRequest(t, app, http.MethodGet, "/api/app/settings", "", token)
	if strings.Contains(read.Body.String(), "stored-telegram-secret") || strings.Contains(read.Body.String(), "stored-ai-secret") {
		t.Fatalf("settings read leaked secret: %s", read.Body.String())
	}

	clear := serveTestRequest(t, app, http.MethodPut, "/api/app/settings", `{"secretUpdates":{"telegramBotToken":{"action":"clear"},"aiRecognition.apiKey":{"action":"keep"}}}`, token)
	if clear.Code != http.StatusOK {
		t.Fatalf("expected secret clear 200, got %d: %s", clear.Code, clear.Body.String())
	}
	clearBody := decodeAPISuccessDataForTest[settingsResponse](t, clear.Body.Bytes())
	if clearBody.SecretStatus["telegramBotToken"].Configured || !clearBody.SecretStatus[aiRecognitionAPIKeySecret].Configured {
		t.Fatalf("unexpected secret status after clear/keep: %#v", clearBody.SecretStatus)
	}

	direct := serveTestRequest(t, app, http.MethodPut, "/api/app/settings", `{"telegramBotToken":"raw-secret"}`, token)
	if direct.Code != http.StatusBadRequest {
		t.Fatalf("expected direct secret field 400, got %d: %s", direct.Code, direct.Body.String())
	}

	invalid := serveTestRequestWithHeaders(t, app, http.MethodPut, "/api/app/settings", `{"secretUpdates":{"telegramBotToken":{"action":"set"}}}`, token, map[string]string{
		"X-Renewlet-Locale": "zh-CN",
	})
	if invalid.Code != http.StatusBadRequest || !strings.Contains(invalid.Body.String(), serverText(localeZhCN, "common.invalidRequestParameters")) {
		t.Fatalf("expected auto account settings validation to follow request locale, got %d: %s", invalid.Code, invalid.Body.String())
	}
}
