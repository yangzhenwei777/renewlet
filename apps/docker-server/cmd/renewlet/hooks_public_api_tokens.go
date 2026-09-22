package main

import (
	"errors"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func normalizePublicStatusPageRecord(record *core.Record) error {
	token := strings.TrimSpace(record.GetString("token"))
	if !publicStatusTokenRe.MatchString(token) {
		return errors.New("PUBLIC_STATUS_PAGE_TOKEN_INVALID")
	}
	record.Set("token", token)
	return nil
}

func normalizeAPITokenRecord(record *core.Record) error {
	name := strings.TrimSpace(record.GetString("name"))
	if name == "" || len([]rune(name)) > 80 {
		return errors.New("API_TOKEN_NAME_INVALID")
	}
	record.Set("name", name)
	tokenHash := strings.TrimSpace(record.GetString("tokenHash"))
	if !publicAPITokenHashRe.MatchString(tokenHash) {
		return errors.New("API_TOKEN_HASH_INVALID")
	}
	record.Set("tokenHash", tokenHash)
	tokenPrefix := strings.TrimSpace(record.GetString("tokenPrefix"))
	if !publicAPITokenPrefixRe.MatchString(tokenPrefix) {
		return errors.New("API_TOKEN_PREFIX_INVALID")
	}
	record.Set("tokenPrefix", tokenPrefix)
	scopes, err := apiTokenScopesFromValue(record.Get("scopes"))
	if err != nil || len(scopes) != 1 || scopes[0] != "read" {
		return errors.New("API_TOKEN_SCOPES_INVALID")
	}
	record.Set("scopes", []string{"read"})
	value := strings.TrimSpace(record.GetString("lastUsedAt"))
	if value != "" {
		if _, err := time.Parse(time.RFC3339Nano, value); err != nil {
			return errors.New("API_TOKEN_TIME_INVALID")
		}
	}
	record.Set("lastUsedAt", value)
	return nil
}

func normalizeTelegramBotBindingRecord(record *core.Record) error {
	chatID := strings.TrimSpace(record.GetString("chatId"))
	if chatID == "" || len([]rune(chatID)) > 128 || strings.ContainsAny(chatID, "\r\n\t") {
		return errors.New("TELEGRAM_BOT_CHAT_ID_INVALID")
	}
	record.Set("chatId", chatID)
	if !telegramSecretHashRe.MatchString(strings.TrimSpace(record.GetString("botTokenHash"))) {
		return errors.New("TELEGRAM_BOT_TOKEN_HASH_INVALID")
	}
	record.Set("botTokenHash", strings.TrimSpace(record.GetString("botTokenHash")))
	if !telegramSecretHashRe.MatchString(strings.TrimSpace(record.GetString("webhookSecretHash"))) {
		return errors.New("TELEGRAM_WEBHOOK_SECRET_HASH_INVALID")
	}
	record.Set("webhookSecretHash", strings.TrimSpace(record.GetString("webhookSecretHash")))
	status := strings.TrimSpace(record.GetString("status"))
	if status != "installing" && status != "installed" {
		return errors.New("TELEGRAM_BOT_STATUS_INVALID")
	}
	record.Set("status", status)
	if record.GetInt("lastUpdateId") < 0 {
		return errors.New("TELEGRAM_BOT_UPDATE_ID_INVALID")
	}
	value := strings.TrimSpace(record.GetString("lastUsedAt"))
	if value != "" {
		if _, err := time.Parse(time.RFC3339Nano, value); err != nil {
			return errors.New("TELEGRAM_BOT_TIME_INVALID")
		}
	}
	record.Set("lastUsedAt", value)
	return nil
}
