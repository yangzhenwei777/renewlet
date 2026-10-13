package main

// 导出 DTO 是 v1 恢复白名单，不能嵌入 appSettings：新增运行时 secret 不得随字段扩展泄漏到快照。
type cloudBackupExportPayload struct {
	Kind          string                `json:"kind"`
	SchemaVersion int                   `json:"schemaVersion"`
	ExportedAt    string                `json:"exportedAt"`
	Data          cloudBackupExportData `json:"data"`
}

type cloudBackupExportData struct {
	Subscriptions         []subscriptionDetailResponse     `json:"subscriptions"`
	Settings              *cloudBackupExportSettingsDTO    `json:"settings,omitempty"`
	CustomConfig          *customConfigPayload             `json:"customConfig,omitempty"`
	ExchangeRateSnapshots []exchangeRateSnapshotDTO        `json:"exchangeRateSnapshots,omitempty"`
	Assets                []cloudBackupExportAssetMetadata `json:"assets,omitempty"`
}

type cloudBackupExportAssetMetadata struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	MimeType  string `json:"mimeType"`
	SizeBytes int64  `json:"sizeBytes"`
}

type cloudBackupExportSettingsDTO struct {
	Locale                             string                    `json:"locale,omitempty"`
	AdminUsername                      string                    `json:"adminUsername"`
	ThemeMode                          string                    `json:"themeMode"`
	ThemeVariant                       string                    `json:"themeVariant"`
	ThemeCustomColor                   themeCustomColor          `json:"themeCustomColor"`
	ShowExpired                        bool                      `json:"showExpired"`
	ShowLunarCalendar                  bool                      `json:"showLunarCalendar"`
	DefaultCurrency                    string                    `json:"defaultCurrency"`
	PublicStatusCurrency               string                    `json:"publicStatusCurrency"`
	SubscriptionPriceReferenceEnabled  bool                      `json:"subscriptionPriceReferenceEnabled"`
	SubscriptionPriceReferenceCurrency string                    `json:"subscriptionPriceReferenceCurrency"`
	ExchangeRateProvider               string                    `json:"exchangeRateProvider"`
	BuiltInIconSources                 builtInIconSourceSettings `json:"builtInIconSources"`
	OnlineIconSources                  onlineIconSourceSettings  `json:"onlineIconSources"`
	AIRecognition                      aiRecognitionSettings     `json:"aiRecognition"`
	MonthlyBudget                      string                    `json:"monthlyBudget"`
	Timezone                           string                    `json:"timezone"`
	NotificationTimeLocal              string                    `json:"notificationTimeLocal"`
	NotificationReminderDays           int                       `json:"notificationReminderDays"`
	EnabledChannels                    []string                  `json:"enabledChannels"`
	TelegramMessageFormat              string                    `json:"telegramMessageFormat"`
	WebhookMethod                      string                    `json:"webhookMethod"`
	DingTalkMessageType                string                    `json:"dingtalkMessageType"`
	WechatMessageType                  string                    `json:"wechatMessageType"`
	WechatAddModeTag                   bool                      `json:"wechatAddModeTag"`
	WechatAtAll                        bool                      `json:"wechatAtAll"`
	NotifyMultipleAddresses            bool                      `json:"notifyMultipleAddresses"`
	BarkSilentPush                     bool                      `json:"barkSilentPush"`
}

func projectCloudBackupExportSettings(settings appSettings) *cloudBackupExportSettingsDTO {
	ai := settings.AIRecognition
	ai.BaseURL, ai.APIKey = "", ""
	out := &cloudBackupExportSettingsDTO{
		AdminUsername:                      settings.AdminUsername,
		ThemeMode:                          settings.ThemeMode,
		ThemeVariant:                       settings.ThemeVariant,
		ThemeCustomColor:                   settings.ThemeCustomColor,
		ShowExpired:                        settings.ShowExpired,
		ShowLunarCalendar:                  settings.ShowLunarCalendar,
		DefaultCurrency:                    settings.DefaultCurrency,
		PublicStatusCurrency:               settings.PublicStatusCurrency,
		SubscriptionPriceReferenceEnabled:  settings.SubscriptionPriceReferenceEnabled,
		SubscriptionPriceReferenceCurrency: settings.SubscriptionPriceReferenceCurrency,
		ExchangeRateProvider:               settings.ExchangeRateProvider,
		BuiltInIconSources:                 settings.BuiltInIconSources,
		OnlineIconSources:                  settings.OnlineIconSources,
		AIRecognition:                      ai,
		MonthlyBudget:                      settings.MonthlyBudget,
		Timezone:                           settings.Timezone,
		NotificationTimeLocal:              settings.NotificationTimeLocal,
		NotificationReminderDays:           settings.NotificationReminderDays,
		EnabledChannels:                    settings.EnabledChannels,
		TelegramMessageFormat:              settings.TelegramMessageFormat,
		WebhookMethod:                      settings.WebhookMethod,
		DingTalkMessageType:                settings.DingTalkMessageType,
		WechatMessageType:                  settings.WechatMessageType,
		WechatAddModeTag:                   settings.WechatAddModeTag,
		WechatAtAll:                        settings.WechatAtAll,
		NotifyMultipleAddresses:            settings.NotifyMultipleAddresses,
		BarkSilentPush:                     settings.BarkSilentPush,
	}
	// v1 用 locale 表示明确偏好；auto 必须省略，导入时才不会覆盖目标账号语言。
	if isSupportedAppLocale(settings.LocalePreference) {
		out.Locale = settings.LocalePreference
	}
	return out
}
