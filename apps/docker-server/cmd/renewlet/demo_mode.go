package main

import (
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	demoModeEnvName          = "RENEWLET_DEMO_MODE"
	demoModeCollectionPage   = 200
	demoModeScheduleTimezone = "Asia/Shanghai"
)

type renewletDemoPolicy struct {
	Email            string
	Password         string
	Name             string
	ResetCron        string
	MaxSubscriptions int
	MaxAssets        int
}

type demoProtectedSettingsSnapshot struct {
	AIRecognition           aiRecognitionSettings
	EnabledChannels         []string
	TestPhone               string
	TelegramBotToken        string
	TelegramChatID          string
	NotifyxAPIKey           string
	WebhookURL              string
	WebhookMethod           string
	WebhookHeaders          string
	WebhookPayload          string
	DingTalkWebhookURL      string
	DingTalkSecret          string
	DingTalkKeyword         string
	DingTalkMessageType     string
	DingTalkTitleTemplate   string
	DingTalkContentTemplate string
	WechatWebhookURL        string
	WechatMessageType       string
	WechatAddModeTag        bool
	WechatAtPhones          string
	WechatAtAll             bool
	SMTPHost                string
	SMTPPort                string
	SMTPSecure              bool
	SMTPUser                string
	SMTPPassword            string
	SMTPFrom                string
	SMTPReplyTo             string
	NotifyMultipleAddresses bool
	RecipientEmail          string
	BarkServerURL           string
	BarkDeviceKey           string
	BarkSilentPush          bool
	ServerChanSendKey       string
	DiscordWebhookURL       string
	DiscordBotUsername      string
	DiscordBotAvatarURL     string
	PushPlusToken           string
}

var demoModePolicy = renewletDemoPolicy{
	Email:     "demo@renewlet.local",
	Password:  "renewlet-demo",
	Name:      "Demo",
	ResetCron: "0 */2 * * *",
	// 100 条基线来自开发者订阅 catalog；额外 20 条只给访客试新增/导入，避免公共 demo 变成无界写入口。
	MaxSubscriptions: 120,
	MaxAssets:        20,
}

// Enabled 只读取单一公开开关；账号、密码、quota 和 reset 周期固定在后端，避免公开 demo 被部署者误配成不可恢复状态。
func (p renewletDemoPolicy) Enabled() bool {
	return envBool(demoModeEnvName, false)
}

func (p renewletDemoPolicy) SetupEnabled() bool {
	return !p.Enabled() && envBool("SETUP_ENABLED", true)
}

func registerDemoResetCron(app core.App) error {
	if !demoModePolicy.Enabled() {
		return nil
	}
	return app.Cron().Add("renewlet_demo_reset", demoModePolicy.ResetCron, func() {
		user, err := demoModePolicy.FindUser(app)
		if err != nil {
			slog.Error("demo mode reset skipped because demo user lookup failed", "error", err)
			return
		}
		if user == nil {
			user, err = demoModePolicy.EnsureUser(app)
			if err != nil {
				slog.Error("demo mode reset skipped because demo user repair failed", "error", err)
				return
			}
		}
		// reset 是公开 demo 的核心状态机：每个 tick 只回收固定 demo 账号的数据，绝不碰其他用户。
		if err := demoModePolicy.ResetUserData(app, user, time.Now().UTC()); err != nil {
			slog.Error("demo mode reset failed", "user", user.Id, "error", err)
		}
	})
}

func ensureDemoMode(app core.App) error {
	if !demoModePolicy.Enabled() {
		return nil
	}
	user, err := demoModePolicy.EnsureUser(app)
	if err != nil {
		return err
	}
	// 启动即 reset 让镜像重启和两小时 cron 具备同一份可重复 demo 基线。
	return demoModePolicy.ResetUserData(app, user, time.Now().UTC())
}

func (p renewletDemoPolicy) EnsureUser(app core.App) (*core.Record, error) {
	user, err := p.FindUser(app)
	if err != nil {
		return nil, err
	}
	if user == nil {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return nil, err
		}
		user = core.NewRecord(users)
	}
	user.Set("name", p.Name)
	user.SetEmail(p.Email)
	user.SetEmailVisibility(true)
	user.SetVerified(true)
	user.SetPassword(p.Password)
	user.Set("role", "user")
	user.Set("banned", false)
	user.Set("banReason", "")
	// 账号修复必须能覆盖被访客尝试改坏的密码/角色；SaveNoValidate 跳过 demo 保护 hook，但仍走 PocketBase 写入流程。
	if err := app.SaveNoValidate(user); err != nil {
		return nil, err
	}
	return user, nil
}

func (p renewletDemoPolicy) FindUser(app core.App) (*core.Record, error) {
	user, err := app.FindAuthRecordByEmail("users", p.Email)
	if err != nil {
		if errorsIsNoRows(err) {
			return nil, nil
		}
		return nil, err
	}
	return user, nil
}

func (p renewletDemoPolicy) ResetUserData(app core.App, user *core.Record, now time.Time) error {
	if !p.Enabled() || user == nil || !p.IsUserRecord(user) {
		return nil
	}
	return app.RunInTransaction(func(txApp core.App) error {
		// 删除和 seed 放在一个事务里，避免访客在 reset 窗口读到半套 settings/subscriptions 状态。
		for _, collection := range []string{
			"notification_jobs",
			"calendar_feeds",
			"public_status_pages",
			"cloud_backup_targets",
			"subscriptions",
			"settings",
			"custom_configs",
			"assets",
		} {
			if err := deleteDemoUserCollectionRecords(txApp, collection, user.Id); err != nil {
				return err
			}
		}
		if err := seedDemoSettings(txApp, user.Id); err != nil {
			return err
		}
		if err := seedDemoSubscriptions(txApp, user.Id, now); err != nil {
			return err
		}
		// Demo reset 会让已分享 token 失效，但不预生成公开页/日历 Feed，保持与普通部署一致的手动生成流程。
		return nil
	})
}

func deleteDemoUserCollectionRecords(app core.App, collection string, userID string) error {
	for {
		records, err := app.FindRecordsByFilter(
			collection,
			"user = {:user}",
			"created",
			demoModeCollectionPage,
			0,
			dbx.Params{"user": userID},
		)
		if err != nil {
			return err
		}
		for _, record := range records {
			if err := app.Delete(record); err != nil {
				return err
			}
		}
		if len(records) < demoModeCollectionPage {
			return nil
		}
	}
}

func (p renewletDemoPolicy) IsUserRecord(record *core.Record) bool {
	return p.Enabled() && record != nil && strings.EqualFold(strings.TrimSpace(record.Email()), p.Email)
}

func (p renewletDemoPolicy) IsUserID(app core.App, userID string) bool {
	if !p.Enabled() || strings.TrimSpace(userID) == "" {
		return false
	}
	user, err := app.FindRecordById("users", strings.TrimSpace(userID))
	return err == nil && p.IsUserRecord(user)
}

func (p renewletDemoPolicy) RejectAccountMutation(e *core.RequestEvent) error {
	if p.IsUserRecord(e.Auth) {
		return e.ForbiddenError(serverText(requestLocale(e.Request), "demo.operationDisabled"), nil)
	}
	return nil
}

func (p renewletDemoPolicy) RejectTargetUserMutation(e *core.RequestEvent, user *core.Record) error {
	if p.IsUserRecord(user) {
		return e.ForbiddenError(serverText(requestLocale(e.Request), "demo.operationDisabled"), nil)
	}
	return nil
}

func (p renewletDemoPolicy) RejectExternalSideEffect(e *core.RequestEvent) error {
	if p.IsUserRecord(e.Auth) {
		return e.ForbiddenError(serverText(requestLocale(e.Request), "demo.operationDisabled"), nil)
	}
	return nil
}

func (p renewletDemoPolicy) RejectSettingsSecretMutation(e *core.RequestEvent, current appSettings, next appSettings) error {
	if p.IsUserRecord(e.Auth) && demoProtectedSettingsChanged(current, next) {
		return e.ForbiddenError(serverText(requestLocale(e.Request), "demo.operationDisabled"), nil)
	}
	return nil
}

func demoModeExternalSideEffectGuard(handler func(*core.RequestEvent) error) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		// demo 访客共享同一账号；任何会触达第三方、远端存储或真实通知渠道的入口都必须在解码前短路。
		if err := demoModePolicy.RejectExternalSideEffect(e); err != nil {
			return err
		}
		return handler(e)
	}
}

func (p renewletDemoPolicy) EnforceRecordValidation(app core.App, record *core.Record) error {
	if !p.Enabled() || record == nil || record.Collection() == nil {
		return nil
	}
	switch record.Collection().Name {
	case "users":
		return p.enforceUserRecordValidation(record)
	case "settings":
		return p.enforceSettingsRecordValidation(app, record)
	case "subscriptions":
		return p.enforceOwnedRecordQuota(app, record, p.MaxSubscriptions, "DEMO_SUBSCRIPTION_QUOTA_EXCEEDED")
	case "assets":
		return p.enforceOwnedRecordQuota(app, record, p.MaxAssets, "DEMO_ASSET_QUOTA_EXCEEDED")
	case "cloud_backup_targets":
		return p.enforceCloudBackupTargetRecordValidation(app, record)
	default:
		return nil
	}
}

func (p renewletDemoPolicy) enforceUserRecordValidation(record *core.Record) error {
	if record.IsNew() {
		if strings.EqualFold(strings.TrimSpace(record.Email()), p.Email) {
			return errors.New("DEMO_ACCOUNT_PROTECTED")
		}
		return nil
	}
	original := record.Original()
	if strings.EqualFold(strings.TrimSpace(original.Email()), p.Email) || strings.EqualFold(strings.TrimSpace(record.Email()), p.Email) {
		// 账号保护放在持久层，覆盖 PocketBase collection REST、SDK 和管理后台，防止访客改密后锁死公共 demo。
		return errors.New("DEMO_ACCOUNT_PROTECTED")
	}
	return nil
}

func (p renewletDemoPolicy) enforceOwnedRecordQuota(app core.App, record *core.Record, maxRecords int, code string) error {
	if !record.IsNew() {
		return nil
	}
	userID := strings.TrimSpace(record.GetString("user"))
	if userID == "" || !p.IsUserID(app, userID) {
		return nil
	}
	total, err := app.CountRecords(record.Collection().Name, dbx.HashExp{"user": userID})
	if err != nil {
		return err
	}
	// quota 是 demo 公共账号的防滥用边界；业务 API、导入和 PocketBase REST 都必须落到这一处计数。
	if total >= int64(maxRecords) {
		return errors.New(code)
	}
	return nil
}

func (p renewletDemoPolicy) enforceSettingsRecordValidation(app core.App, record *core.Record) error {
	userID := strings.TrimSpace(record.GetString("user"))
	if userID == "" || !p.IsUserID(app, userID) {
		return nil
	}
	current := defaultAppSettings()
	if !record.IsNew() {
		settings, err := settingsFromValue(record.Original().Get("settings"))
		if err != nil {
			return err
		}
		current = settings
	}
	next, err := settingsFromValue(record.Get("settings"))
	if err != nil {
		return err
	}
	if demoProtectedSettingsChanged(current, next) {
		// settings 是整包保存；hook 只比较外部集成受保护子集，避免 demo 账号保存主题/预算时被误伤。
		return errors.New("DEMO_SETTINGS_PROTECTED")
	}
	return nil
}

func (p renewletDemoPolicy) enforceCloudBackupTargetRecordValidation(app core.App, record *core.Record) error {
	userID := strings.TrimSpace(record.GetString("user"))
	if userID == "" || !p.IsUserID(app, userID) {
		return nil
	}
	// 云备份 target 持有 write-only credential；hook 必须覆盖 REST/SDK/Admin UI，route 置灰不能作为安全边界。
	return errors.New("DEMO_CLOUD_BACKUP_TARGET_PROTECTED")
}

func (p renewletDemoPolicy) EnforceRecordDelete(record *core.Record) error {
	if p.IsUserRecord(record) {
		// 删除 demo 用户会级联清空账号本身，后续访客无法用固定凭据登录，只允许启动修复重新覆盖。
		return errors.New("DEMO_ACCOUNT_PROTECTED")
	}
	return nil
}

func demoProtectedSettingsChanged(current appSettings, next appSettings) bool {
	return !reflect.DeepEqual(demoProtectedSettingsSnapshotFrom(current), demoProtectedSettingsSnapshotFrom(next))
}

func demoProtectedSettingsSnapshotFrom(settings appSettings) demoProtectedSettingsSnapshot {
	settings = sanitizeSettings(settings)
	return demoProtectedSettingsSnapshot{
		AIRecognition:           settings.AIRecognition,
		EnabledChannels:         append([]string(nil), settings.EnabledChannels...),
		TestPhone:               strings.TrimSpace(settings.TestPhone),
		TelegramBotToken:        strings.TrimSpace(settings.TelegramBotToken),
		TelegramChatID:          strings.TrimSpace(settings.TelegramChatID),
		NotifyxAPIKey:           strings.TrimSpace(settings.NotifyxAPIKey),
		WebhookURL:              strings.TrimSpace(settings.WebhookURL),
		WebhookMethod:           strings.TrimSpace(settings.WebhookMethod),
		WebhookHeaders:          strings.TrimSpace(settings.WebhookHeaders),
		WebhookPayload:          strings.TrimSpace(settings.WebhookPayload),
		DingTalkWebhookURL:      strings.TrimSpace(settings.DingTalkWebhookURL),
		DingTalkSecret:          strings.TrimSpace(settings.DingTalkSecret),
		DingTalkKeyword:         strings.TrimSpace(settings.DingTalkKeyword),
		DingTalkMessageType:     strings.TrimSpace(settings.DingTalkMessageType),
		DingTalkTitleTemplate:   strings.TrimSpace(settings.DingTalkTitleTemplate),
		DingTalkContentTemplate: strings.TrimSpace(settings.DingTalkContentTemplate),
		WechatWebhookURL:        strings.TrimSpace(settings.WechatWebhookURL),
		WechatMessageType:       strings.TrimSpace(settings.WechatMessageType),
		WechatAddModeTag:        settings.WechatAddModeTag,
		WechatAtPhones:          strings.TrimSpace(settings.WechatAtPhones),
		WechatAtAll:             settings.WechatAtAll,
		SMTPHost:                strings.TrimSpace(settings.SMTPHost),
		SMTPPort:                strings.TrimSpace(settings.SMTPPort),
		SMTPSecure:              settings.SMTPSecure,
		SMTPUser:                strings.TrimSpace(settings.SMTPUser),
		SMTPPassword:            strings.TrimSpace(settings.SMTPPassword),
		SMTPFrom:                strings.TrimSpace(settings.SMTPFrom),
		SMTPReplyTo:             strings.TrimSpace(settings.SMTPReplyTo),
		NotifyMultipleAddresses: settings.NotifyMultipleAddresses,
		RecipientEmail:          strings.TrimSpace(settings.RecipientEmail),
		BarkServerURL:           strings.TrimSpace(settings.BarkServerURL),
		BarkDeviceKey:           strings.TrimSpace(settings.BarkDeviceKey),
		BarkSilentPush:          settings.BarkSilentPush,
		ServerChanSendKey:       strings.TrimSpace(settings.ServerChanSendKey),
		DiscordWebhookURL:       strings.TrimSpace(settings.DiscordWebhookURL),
		DiscordBotUsername:      strings.TrimSpace(settings.DiscordBotUsername),
		DiscordBotAvatarURL:     strings.TrimSpace(settings.DiscordBotAvatarURL),
		PushPlusToken:           strings.TrimSpace(settings.PushPlusToken),
	}
}
