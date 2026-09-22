package main

// notification_settings.go 处理 settings JSON 到通知领域设置的严格收敛。
//
// 架构位置：PocketBase JSON 字段、测试请求中的临时 patch 都必须先经过这里，
// 再进入消息构建或渠道发送，避免动态 JSON 在业务层扩散。
//
// 注意： sanitizeSettings 只处理独立的历史脏字段；route body 和已迁移语言契约仍在 strict decoder 阶段失败。
import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

var settingsCurrencyRe = regexp.MustCompile(`^[A-Z]{3}$`)

func findSettingsRecord(app core.App, userID string) (*core.Record, error) {
	return app.FindFirstRecordByFilter("settings", "user = {:user}", dbx.Params{"user": userID})
}

func settingsRecordOrDefault(app core.App, userID string) (*core.Record, appSettings, error) {
	record, err := findSettingsRecord(app, userID)
	if err == nil && record != nil {
		settings, parseErr := settingsFromRecord(record)
		return record, settings, parseErr
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, appSettings{}, err
	}
	return nil, defaultAppSettings(), nil
}

func createSettingsRecord(app core.App, userID string, settings appSettings) (*core.Record, error) {
	collection, err := app.FindCollectionByNameOrId("settings")
	if err != nil {
		return nil, err
	}
	record := core.NewRecord(collection)
	record.Set("user", userID)
	record.Set("settings", settings)
	if err := app.Save(record); err != nil {
		return nil, err
	}
	return record, nil
}

func ensureSettingsRecord(app core.App, userID string) (*core.Record, appSettings, error) {
	record, settings, err := settingsRecordOrDefault(app, userID)
	if err != nil || record != nil {
		return record, settings, err
	}
	record, err = createSettingsRecord(app, userID, settings)
	if err != nil {
		if existing, findErr := findSettingsRecord(app, userID); findErr == nil && existing != nil {
			existingSettings, parseErr := settingsFromRecord(existing)
			return existing, existingSettings, parseErr
		}
		return nil, appSettings{}, err
	}
	stored, err := settingsFromRecord(record)
	return record, stored, err
}

func currentUserSettings(app core.App, user *core.Record) (appSettings, error) {
	settings := defaultAppSettings()
	if user == nil {
		return settings, nil
	}
	record, err := app.FindFirstRecordByFilter("settings", "user = {:user}", dbx.Params{"user": user.Id})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return settings, nil
		}
		return appSettings{}, err
	}
	return settingsFromRecord(record)
}

// 请求级设置覆盖只服务通知测试/手动运行；校验文案跟随当前请求，临时 patch 绝不写回账号设置。
func currentUserSettingsWithPatch(app core.App, user *core.Record, patch json.RawMessage, locale appLocale) (appSettings, error) {
	settings, err := currentUserSettings(app, user)
	if err != nil {
		return settings, err
	}
	if len(bytes.TrimSpace(patch)) == 0 {
		return settings, nil
	}
	return mergeSettingsRequest(settings, patch, locale)
}

func settingsFromRecord(record *core.Record) (appSettings, error) {
	// 排他迁移后，存在的 settings 记录必须满足数据库契约；静默回落会掩盖漂移并以默认值执行后台任务。
	return settingsFromValue(record.Get("settings"))
}

func settingsFromValue(value interface{}) (appSettings, error) {
	settings := defaultAppSettings()
	data, err := jsonBytesFromValue(value)
	if err != nil {
		return appSettings{}, err
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return appSettings{}, errors.New("APP_SETTINGS_REQUIRED")
	}
	if _, present, err := explicitSettingsStringPatch(data, "localePreference"); err != nil {
		return appSettings{}, err
	} else if !present {
		return appSettings{}, errors.New("APP_LOCALE_PREFERENCE_REQUIRED")
	}
	return mergeSettings(settings, json.RawMessage(data))
}

// mergeSettings 将 patch 严格解码到默认/当前设置上。
// 使用完整 appSettings 目标而非 map，是为了让未知字段和非法类型在边界失败。
func mergeSettings(base appSettings, patch json.RawMessage) (appSettings, error) {
	return mergeSettingsWithOptions(base, patch, false, defaultAppLocale)
}

func mergeSettingsForWrite(base appSettings, patch json.RawMessage) (appSettings, error) {
	return mergeSettingsWithOptions(base, patch, true, defaultAppLocale)
}

func mergeSettingsWithOptions(base appSettings, patch json.RawMessage, validateWriteFields bool, validationLocale appLocale) (appSettings, error) {
	if len(bytes.TrimSpace(patch)) == 0 {
		return base, nil
	}
	if !validateWriteFields {
		patch = normalizeRecoverableStoredSettingsPatch(patch)
	}
	settings := base
	sourcePatch, err := decodeBuiltInIconSourcePatch(patch, string(validationLocale))
	if err != nil {
		return base, err
	}
	onlineSourcePatch, err := decodeOnlineIconSourcePatch(patch, string(validationLocale))
	if err != nil {
		return base, err
	}
	if err := decodeStrictJSONBytesInto(patch, &settings, validationLocale, false); err != nil {
		return base, err
	}
	// 旧语言值只归一次性 migration 所有；运行时读取与写入都必须拒绝迁移后的契约漂移。
	if !isSupportedLocalePreference(settings.LocalePreference) {
		return base, errors.New("APP_LOCALE_PREFERENCE_UNSUPPORTED")
	}
	if validateWriteFields {
		// Telegram 消息样式是跨运行面枚举；写入边界拒绝未知值，坏库值才允许在 sanitizeSettings 回落 plain。
		if format, ok, err := explicitSettingsStringPatch(patch, "telegramMessageFormat"); err != nil {
			return base, err
		} else if ok && format != telegramMessageFormatPlain && format != telegramMessageFormatHTML {
			return base, errors.New("TELEGRAM_MESSAGE_FORMAT_UNSUPPORTED")
		}
		if referenceCurrency, ok, err := explicitSettingsStringPatch(patch, "subscriptionPriceReferenceCurrency"); err != nil {
			return base, err
		} else if ok && referenceCurrency != "default" && !settingsCurrencyRe.MatchString(referenceCurrency) {
			return base, errors.New("SUBSCRIPTION_PRICE_REFERENCE_CURRENCY_UNSUPPORTED")
		}
		// 钉钉 payload 结构由渠道发送器统一生成；写入边界只接受官方机器人支持的正文类型。
		if messageType, ok, err := explicitSettingsStringPatch(patch, "dingtalkMessageType"); err != nil {
			return base, err
		} else if ok && messageType != dingtalkMessageTypeMarkdown && messageType != dingtalkMessageTypeText {
			return base, errors.New("DINGTALK_MESSAGE_TYPE_UNSUPPORTED")
		}
		if titleTemplate, ok, err := explicitSettingsStringPatch(patch, "dingtalkTitleTemplate"); err != nil {
			return base, err
		} else if ok && runeCount(titleTemplate) > dingtalkTitleTemplateMaxRunes {
			return base, errors.New("DINGTALK_TITLE_TEMPLATE_TOO_LONG")
		}
		if contentTemplate, ok, err := explicitSettingsStringPatch(patch, "dingtalkContentTemplate"); err != nil {
			return base, err
		} else if ok && runeCount(contentTemplate) > dingtalkContentTemplateMaxRunes {
			return base, errors.New("DINGTALK_CONTENT_TEMPLATE_TOO_LONG")
		}
		if monthlyBudget, ok, err := explicitSettingsStringPatch(patch, "monthlyBudget"); err != nil {
			return base, err
		} else if ok {
			canonical, err := canonicalMoneyString(monthlyBudget)
			if err != nil {
				return base, errors.New("MONTHLY_BUDGET_INVALID")
			}
			settings.MonthlyBudget = canonical
		}
	}
	settings.BuiltInIconSources = mergeBuiltInIconSourceSettings(base.BuiltInIconSources, sourcePatch)
	settings.OnlineIconSources = mergeOnlineIconSourceSettings(base.OnlineIconSources, onlineSourcePatch)
	if !hasEnabledBuiltInIconSource(settings.BuiltInIconSources) {
		return base, errors.New("BUILT_IN_ICON_SOURCE_REQUIRED")
	}
	return sanitizeSettings(settings), nil
}

func explicitSettingsStringPatch(raw json.RawMessage, key string) (string, bool, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return "", false, err
	}
	value, ok := fields[key]
	if !ok {
		return "", false, nil
	}
	var text string
	if err := json.Unmarshal(value, &text); err != nil {
		return "", true, err
	}
	return text, true, nil
}

func normalizeRecoverableStoredSettingsPatch(raw json.RawMessage) json.RawMessage {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return raw
	}
	changed := false
	normalizeTemplate := func(key string, maxRunes int) {
		value, ok := fields[key]
		if !ok {
			return
		}
		var text string
		if err := json.Unmarshal(value, &text); err != nil || runeCount(text) > maxRunes {
			// 历史/手改 settings JSON 只清坏模板字段；写入路径仍由 strict decoder 和长度校验拒绝。
			fields[key] = json.RawMessage(`""`)
			changed = true
		}
	}
	normalizeTemplate("dingtalkTitleTemplate", dingtalkTitleTemplateMaxRunes)
	normalizeTemplate("dingtalkContentTemplate", dingtalkContentTemplateMaxRunes)
	if value, ok := fields["monthlyBudget"]; ok {
		var rawValue interface{}
		if err := json.Unmarshal(value, &rawValue); err == nil {
			if amount, err := canonicalMoneyFromValue(rawValue); err == nil {
				encoded, _ := json.Marshal(amount)
				if !bytes.Equal(value, encoded) {
					// 历史 settings_json 里的 number 只在读取/迁移边界转成 string；新写入仍由 strict decoder 拒绝 number。
					fields["monthlyBudget"] = encoded
					changed = true
				}
			}
		}
	}
	if !changed {
		return raw
	}
	data, err := json.Marshal(fields)
	if err != nil {
		return raw
	}
	return data
}

// sanitizeSettings 对可恢复的设置值做保守归一。
// 注意： 这里只修复默认值/枚举兜底，不应吞掉 route body 的严格校验职责。
func sanitizeSettings(settings appSettings) appSettings {
	if settings.ExchangeRateProvider != "frankfurter" && settings.ExchangeRateProvider != "floatrates" && settings.ExchangeRateProvider != "exchange-api" {
		// 只有历史/手改坏库值回落到新默认；已保存的旧 provider 是用户选择，不能在读取时强迁移。
		settings.ExchangeRateProvider = "frankfurter"
	}
	if settings.PublicStatusCurrency != "inherit" && !settingsCurrencyRe.MatchString(settings.PublicStatusCurrency) {
		settings.PublicStatusCurrency = "inherit"
	}
	if settings.SubscriptionPriceReferenceCurrency != "default" && !settingsCurrencyRe.MatchString(settings.SubscriptionPriceReferenceCurrency) {
		settings.SubscriptionPriceReferenceCurrency = "default"
	}
	settings.BuiltInIconSources = sanitizeBuiltInIconSources(settings.BuiltInIconSources)
	settings.OnlineIconSources = sanitizeOnlineIconSources(settings.OnlineIconSources)
	settings.AIRecognition = sanitizeAIRecognitionSettings(settings.AIRecognition)
	if amount, err := canonicalMoneyString(settings.MonthlyBudget); err == nil {
		settings.MonthlyBudget = amount
	} else {
		settings.MonthlyBudget = defaultAppSettings().MonthlyBudget
	}
	if _, err := time.LoadLocation(settings.Timezone); err != nil {
		settings.Timezone = "UTC"
	}
	if !isValidLocalTime(settings.NotificationTimeLocal) {
		settings.NotificationTimeLocal = "08:00"
	}
	settings.NotificationReminderDays = normalizeNotificationReminderDays(settings.NotificationReminderDays)
	settings.EnabledChannels = uniqueValidChannels(settings.EnabledChannels)
	if settings.TelegramMessageFormat != telegramMessageFormatHTML && settings.TelegramMessageFormat != telegramMessageFormatPlain {
		// 历史/手改 settings JSON 只降级 Telegram 样式，不应让整份设置回默认导致通知渠道丢失。
		settings.TelegramMessageFormat = telegramMessageFormatPlain
	}
	if settings.WebhookMethod != "GET" && settings.WebhookMethod != "POST" {
		settings.WebhookMethod = "POST"
	}
	settings.WebhookHeaders = clearLegacyWebhookExample(settings.WebhookHeaders, legacyWebhookHeadersExample)
	settings.WebhookPayload = clearLegacyWebhookExample(settings.WebhookPayload, legacyWebhookPayloadExample)
	if settings.DingTalkMessageType != dingtalkMessageTypeMarkdown && settings.DingTalkMessageType != dingtalkMessageTypeText {
		settings.DingTalkMessageType = dingtalkMessageTypeMarkdown
	}
	if runeCount(settings.DingTalkTitleTemplate) > dingtalkTitleTemplateMaxRunes {
		settings.DingTalkTitleTemplate = ""
	}
	if runeCount(settings.DingTalkContentTemplate) > dingtalkContentTemplateMaxRunes {
		settings.DingTalkContentTemplate = ""
	}
	if settings.WechatMessageType != "markdown" && settings.WechatMessageType != "text" {
		settings.WechatMessageType = "text"
	}
	if strings.TrimSpace(settings.BarkServerURL) == "" {
		settings.BarkServerURL = "https://api.day.app"
	}
	return settings
}

func runeCount(value string) int {
	return len([]rune(value))
}

func sanitizeBuiltInIconSources(settings builtInIconSourceSettings) builtInIconSourceSettings {
	out := mergeBuiltInIconSourceSettings(defaultBuiltInIconSourceSettings(), builtInIconSourceSettingsToPatch(settings))
	enabledCount := 0
	for _, setting := range out {
		if setting.Enabled {
			enabledCount++
		}
	}
	if enabledCount == 0 {
		return defaultBuiltInIconSourceSettings()
	}
	return out
}

func sanitizeOnlineIconSources(settings onlineIconSourceSettings) onlineIconSourceSettings {
	// 读取历史 settings 时补齐 App Store storefronts；写入路径仍由 onlineIconSourceSettingPatch 严格拒绝空/重复/未知地区。
	return mergeOnlineIconSourceSettings(defaultOnlineIconSourceSettings(), onlineIconSourceSettingsToPatch(settings))
}

func decodeBuiltInIconSourcePatch(raw json.RawMessage, locale string) (map[string]builtInIconSourceSettingPatch, error) {
	var envelope map[string]json.RawMessage
	if err := decodeStrictJSONBytesInto(raw, &envelope, normalizeAppLocale(locale), false); err != nil {
		return nil, err
	}
	sourceRaw, ok := envelope["builtInIconSources"]
	if !ok {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(sourceRaw), []byte("null")) {
		return nil, errors.New("BUILT_IN_ICON_SOURCE_INVALID")
	}
	var sources map[string]builtInIconSourceSettingPatch
	if err := json.Unmarshal(sourceRaw, &sources); err != nil {
		return nil, err
	}
	defaults := defaultBuiltInIconSourceSettings()
	for provider := range sources {
		if _, ok := defaults[provider]; !ok {
			return nil, fmt.Errorf("json: unknown field %q", provider)
		}
	}
	return sources, nil
}

func decodeOnlineIconSourcePatch(raw json.RawMessage, locale string) (map[string]onlineIconSourceSettingPatch, error) {
	var envelope map[string]json.RawMessage
	if err := decodeStrictJSONBytesInto(raw, &envelope, normalizeAppLocale(locale), false); err != nil {
		return nil, err
	}
	sourceRaw, ok := envelope["onlineIconSources"]
	if !ok {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(sourceRaw), []byte("null")) {
		return nil, errors.New("ONLINE_ICON_SOURCE_INVALID")
	}
	var sources map[string]onlineIconSourceSettingPatch
	if err := json.Unmarshal(sourceRaw, &sources); err != nil {
		return nil, err
	}
	defaults := defaultOnlineIconSourceSettings()
	for provider := range sources {
		if _, ok := defaults[provider]; !ok {
			return nil, fmt.Errorf("json: unknown field %q", provider)
		}
	}
	return sources, nil
}

func builtInIconSourceSettingsToPatch(settings builtInIconSourceSettings) map[string]builtInIconSourceSettingPatch {
	patch := map[string]builtInIconSourceSettingPatch{}
	for provider, setting := range settings {
		enabled := setting.Enabled
		variantsEnabled := setting.VariantsEnabled
		patch[provider] = builtInIconSourceSettingPatch{Enabled: &enabled, VariantsEnabled: &variantsEnabled}
	}
	return patch
}

func onlineIconSourceSettingsToPatch(settings onlineIconSourceSettings) map[string]onlineIconSourceSettingPatch {
	patch := map[string]onlineIconSourceSettingPatch{}
	for provider, setting := range settings {
		enabled := setting.Enabled
		storefronts := appStoreStorefrontsOrDefault(setting.Storefronts)
		patch[provider] = onlineIconSourceSettingPatch{Enabled: &enabled, Storefronts: &storefronts}
	}
	return patch
}

func mergeBuiltInIconSourceSettings(base builtInIconSourceSettings, patch map[string]builtInIconSourceSettingPatch) builtInIconSourceSettings {
	defaults := defaultBuiltInIconSourceSettings()
	out := builtInIconSourceSettings{}
	for provider, defaultSetting := range defaults {
		setting, ok := base[provider]
		if !ok {
			setting = defaultSetting
		}
		if patchSetting, ok := patch[provider]; ok {
			if patchSetting.Enabled != nil {
				setting.Enabled = *patchSetting.Enabled
			}
			if patchSetting.VariantsEnabled != nil {
				setting.VariantsEnabled = *patchSetting.VariantsEnabled
			}
		}
		out[provider] = setting
	}
	return out
}

func mergeOnlineIconSourceSettings(base onlineIconSourceSettings, patch map[string]onlineIconSourceSettingPatch) onlineIconSourceSettings {
	defaults := defaultOnlineIconSourceSettings()
	out := onlineIconSourceSettings{}
	for provider, defaultSetting := range defaults {
		setting, ok := base[provider]
		if !ok {
			setting = defaultSetting
		}
		if provider == appStoreOnlineIconSource {
			// 历史库值缺 storefronts 时读成默认 US；这不是关闭语义，避免静默保存成“不查任何地区”。
			setting.Storefronts = appStoreStorefrontsOrDefault(setting.Storefronts)
		}
		if patchSetting, ok := patch[provider]; ok {
			if patchSetting.Enabled != nil {
				setting.Enabled = *patchSetting.Enabled
			}
			if patchSetting.Storefronts != nil {
				setting.Storefronts = cloneStringSlice(*patchSetting.Storefronts)
			}
		}
		out[provider] = setting
	}
	return out
}

func (s *builtInIconSourceSettingPatch) UnmarshalJSON(data []byte) error {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return errors.New("BUILT_IN_ICON_SOURCE_INVALID")
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	for key, value := range raw {
		switch key {
		case "enabled":
			var enabled bool
			if err := json.Unmarshal(value, &enabled); err != nil {
				return err
			}
			s.Enabled = &enabled
		case "variantsEnabled":
			var variantsEnabled bool
			if err := json.Unmarshal(value, &variantsEnabled); err != nil {
				return err
			}
			s.VariantsEnabled = &variantsEnabled
		default:
			return fmt.Errorf("json: unknown field %q", key)
		}
	}
	return nil
}

func (s *onlineIconSourceSettingPatch) UnmarshalJSON(data []byte) error {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return errors.New("ONLINE_ICON_SOURCE_INVALID")
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	for key, value := range raw {
		switch key {
		case "enabled":
			var enabled bool
			if err := json.Unmarshal(value, &enabled); err != nil {
				return err
			}
			s.Enabled = &enabled
		case "storefronts":
			var storefronts []string
			if err := json.Unmarshal(value, &storefronts); err != nil {
				return err
			}
			normalized, ok := normalizeAppStoreStorefronts(storefronts)
			if !ok {
				return errors.New("APP_STORE_STOREFRONTS_INVALID")
			}
			s.Storefronts = &normalized
		default:
			return fmt.Errorf("json: unknown field %q", key)
		}
	}
	return nil
}

func hasEnabledBuiltInIconSource(settings builtInIconSourceSettings) bool {
	for _, setting := range settings {
		if setting.Enabled {
			return true
		}
	}
	return false
}

func clearLegacyWebhookExample(value, legacyExample string) string {
	if strings.TrimSpace(value) == legacyExample {
		return ""
	}
	return value
}

func uniqueValidChannels(channels []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(channels))
	for _, channel := range channels {
		channel = strings.TrimSpace(channel)
		if _, ok := knownChannels[channel]; !ok {
			continue
		}
		if _, ok := seen[channel]; ok {
			continue
		}
		// 顺序保持用户设置顺序，但去重后发送，避免同一渠道重复推送。
		seen[channel] = struct{}{}
		out = append(out, channel)
	}
	return out
}
