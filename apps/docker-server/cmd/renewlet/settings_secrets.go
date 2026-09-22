package main

// settings_secrets.go 定义 settings HTTP 边界的 write-only secret 契约。
// 持久化 appSettings 仍保留完整字段；公开响应只返回 configured 状态，临时测试和保存共用同一 mutation 语义。
import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const aiRecognitionAPIKeySecret = "aiRecognition.apiKey"

// nested AI key 固定放在末尾；需要处理顶层 JSON 字段的循环只遍历此前元素，避免误删整个 aiRecognition 对象。
var settingsSecretKeys = []string{
	"telegramBotToken",
	"notifyxApiKey",
	"webhookUrl",
	"webhookHeaders",
	"dingtalkWebhookUrl",
	"dingtalkSecret",
	"wechatWebhookUrl",
	"smtpPassword",
	"barkDeviceKey",
	"serverchanSendKey",
	"discordWebhookUrl",
	"pushplusToken",
	aiRecognitionAPIKeySecret,
}

type settingsSecretMutation struct {
	Action string  `json:"action"`
	Value  *string `json:"value,omitempty"`
}

func (m *settingsSecretMutation) Validate(locale appLocale) error {
	switch m.Action {
	case "keep", "clear":
		if m.Value != nil {
			return errors.New(serverText(locale, "common.invalidRequestParameters"))
		}
	case "set":
		if m.Value == nil || *m.Value == "" || len(*m.Value) > 100_000 {
			return errors.New(serverText(locale, "common.invalidRequestParameters"))
		}
	default:
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	return nil
}

type settingsSecretUpdates struct {
	TelegramBotToken   *settingsSecretMutation `json:"telegramBotToken,omitempty"`
	NotifyxAPIKey      *settingsSecretMutation `json:"notifyxApiKey,omitempty"`
	WebhookURL         *settingsSecretMutation `json:"webhookUrl,omitempty"`
	WebhookHeaders     *settingsSecretMutation `json:"webhookHeaders,omitempty"`
	DingTalkWebhookURL *settingsSecretMutation `json:"dingtalkWebhookUrl,omitempty"`
	DingTalkSecret     *settingsSecretMutation `json:"dingtalkSecret,omitempty"`
	WechatWebhookURL   *settingsSecretMutation `json:"wechatWebhookUrl,omitempty"`
	SMTPPassword       *settingsSecretMutation `json:"smtpPassword,omitempty"`
	BarkDeviceKey      *settingsSecretMutation `json:"barkDeviceKey,omitempty"`
	ServerChanSendKey  *settingsSecretMutation `json:"serverchanSendKey,omitempty"`
	DiscordWebhookURL  *settingsSecretMutation `json:"discordWebhookUrl,omitempty"`
	PushPlusToken      *settingsSecretMutation `json:"pushplusToken,omitempty"`
	AIRecognitionKey   *settingsSecretMutation `json:"aiRecognition.apiKey,omitempty"`
}

type settingsSecretConfiguredStatus struct {
	Configured bool `json:"configured"`
}

type publicAppSettings appSettings

func (settings publicAppSettings) MarshalJSON() ([]byte, error) {
	// 公开 view 从完整持久化结构生成后统一删 secret，避免新增普通字段时再维护一份易漂移的复制 DTO。
	data, err := json.Marshal(appSettings(settings))
	if err != nil {
		return nil, err
	}
	var public map[string]json.RawMessage
	if err := json.Unmarshal(data, &public); err != nil {
		return nil, err
	}
	for _, key := range settingsSecretKeys[:len(settingsSecretKeys)-1] {
		delete(public, key)
	}
	var ai map[string]json.RawMessage
	if err := json.Unmarshal(public["aiRecognition"], &ai); err != nil {
		return nil, err
	}
	delete(ai, "apiKey")
	public["aiRecognition"], err = json.Marshal(ai)
	if err != nil {
		return nil, err
	}
	return json.Marshal(public)
}

func newSettingsResponse(settings appSettings) settingsResponse {
	return settingsResponse{
		Settings:     publicAppSettings(settings),
		SecretStatus: appSettingsSecretStatus(settings),
	}
}

func appSettingsSecretStatus(settings appSettings) map[string]settingsSecretConfiguredStatus {
	values := map[string]string{
		"telegramBotToken":        settings.TelegramBotToken,
		"notifyxApiKey":           settings.NotifyxAPIKey,
		"webhookUrl":              settings.WebhookURL,
		"webhookHeaders":          settings.WebhookHeaders,
		"dingtalkWebhookUrl":      settings.DingTalkWebhookURL,
		"dingtalkSecret":          settings.DingTalkSecret,
		"wechatWebhookUrl":        settings.WechatWebhookURL,
		"smtpPassword":            settings.SMTPPassword,
		"barkDeviceKey":           settings.BarkDeviceKey,
		"serverchanSendKey":       settings.ServerChanSendKey,
		"discordWebhookUrl":       settings.DiscordWebhookURL,
		"pushplusToken":           settings.PushPlusToken,
		aiRecognitionAPIKeySecret: settings.AIRecognition.APIKey,
	}
	status := make(map[string]settingsSecretConfiguredStatus, len(values))
	for _, key := range settingsSecretKeys {
		status[key] = settingsSecretConfiguredStatus{Configured: strings.TrimSpace(values[key]) != ""}
	}
	return status
}

func mergeSettingsRequest(base appSettings, raw json.RawMessage, locale appLocale) (appSettings, error) {
	// 裸 secret 字段必须先拒绝，再合并公共 patch 和判别联合；否则旧客户端可能把响应中的空值误写成 clear。
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return base, err
	}
	for _, key := range settingsSecretKeys[:len(settingsSecretKeys)-1] {
		if _, exists := fields[key]; exists {
			return base, fmt.Errorf("json: secret field %q must use secretUpdates", key)
		}
	}
	if aiRaw, exists := fields["aiRecognition"]; exists {
		var aiFields map[string]json.RawMessage
		if err := json.Unmarshal(aiRaw, &aiFields); err != nil {
			return base, err
		}
		if _, exists := aiFields["apiKey"]; exists {
			return base, errors.New("json: aiRecognition.apiKey must use secretUpdates")
		}
	}

	var updates settingsSecretUpdates
	if updatesRaw, exists := fields["secretUpdates"]; exists {
		if bytes.Equal(bytes.TrimSpace(updatesRaw), []byte("null")) {
			return base, errors.New("secretUpdates cannot be null")
		}
		if err := decodeStrictJSONBytesInto(updatesRaw, &updates, locale, false); err != nil {
			return base, err
		}
		delete(fields, "secretUpdates")
	}
	publicRaw, err := json.Marshal(fields)
	if err != nil {
		return base, err
	}
	next, err := mergeSettingsWithOptions(base, publicRaw, true, locale)
	if err != nil {
		return base, err
	}
	if err := applySettingsSecretUpdates(&next, updates, locale); err != nil {
		return base, err
	}
	return sanitizeSettings(next), nil
}

func applySettingsSecretUpdates(settings *appSettings, updates settingsSecretUpdates, locale appLocale) error {
	apply := func(current *string, mutation *settingsSecretMutation) error {
		if mutation == nil {
			return nil
		}
		if err := mutation.Validate(locale); err != nil {
			return err
		}
		if mutation.Action == "keep" {
			return nil
		}
		if mutation.Action == "clear" {
			*current = ""
			return nil
		}
		*current = *mutation.Value
		return nil
	}
	for _, pair := range []struct {
		value    *string
		mutation *settingsSecretMutation
	}{
		{&settings.TelegramBotToken, updates.TelegramBotToken},
		{&settings.NotifyxAPIKey, updates.NotifyxAPIKey},
		{&settings.WebhookURL, updates.WebhookURL},
		{&settings.WebhookHeaders, updates.WebhookHeaders},
		{&settings.DingTalkWebhookURL, updates.DingTalkWebhookURL},
		{&settings.DingTalkSecret, updates.DingTalkSecret},
		{&settings.WechatWebhookURL, updates.WechatWebhookURL},
		{&settings.SMTPPassword, updates.SMTPPassword},
		{&settings.BarkDeviceKey, updates.BarkDeviceKey},
		{&settings.ServerChanSendKey, updates.ServerChanSendKey},
		{&settings.DiscordWebhookURL, updates.DiscordWebhookURL},
		{&settings.PushPlusToken, updates.PushPlusToken},
		{&settings.AIRecognition.APIKey, updates.AIRecognitionKey},
	} {
		if err := apply(pair.value, pair.mutation); err != nil {
			return err
		}
	}
	return nil
}

func resolveSettingsSecretMutation(mutation settingsSecretMutation, current string, locale appLocale) (string, error) {
	if err := mutation.Validate(locale); err != nil {
		return "", err
	}
	if mutation.Action == "keep" {
		return current, nil
	}
	if mutation.Action == "clear" {
		return "", nil
	}
	return *mutation.Value, nil
}
