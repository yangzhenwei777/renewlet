package main

// Schema 测试保护 PocketBase collection 自愈、索引和迁移收敛。
// 字段默认值、date-only、autoRenew 和 Logo URL 契约改动必须先在这里证明旧库能被收敛到当前形状。

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

func newSchemaTestApp(t *testing.T) *pocketbase.PocketBase {
	t.Helper()
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: t.TempDir()})
	registerAuthHooks(app)
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = app.ResetBootstrapState()
	})
	return app
}

func TestEnsureSchemaCreatesContractFieldsAndIndexes(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}

	assertFields(t, app, "subscriptions", map[string]string{
		"user":                                  core.FieldTypeRelation,
		"name":                                  core.FieldTypeText,
		"logo":                                  core.FieldTypeText,
		"price":                                 core.FieldTypeText,
		"currency":                              core.FieldTypeText,
		"billingCycle":                          core.FieldTypeSelect,
		"customDays":                            core.FieldTypeNumber,
		"customCycleUnit":                       core.FieldTypeSelect,
		"oneTimeTermCount":                      core.FieldTypeNumber,
		"oneTimeTermUnit":                       core.FieldTypeSelect,
		"category":                              core.FieldTypeText,
		"status":                                core.FieldTypeSelect,
		"pinned":                                core.FieldTypeBool,
		"publicHidden":                          core.FieldTypeBool,
		"paymentMethod":                         core.FieldTypeText,
		"startDate":                             core.FieldTypeText,
		"nextBillingDate":                       core.FieldTypeText,
		"autoRenew":                             core.FieldTypeBool,
		"autoCalculateNextBillingDate":          core.FieldTypeBool,
		"trialEndDate":                          core.FieldTypeText,
		"website":                               core.FieldTypeURL,
		"notes":                                 core.FieldTypeText,
		"tags":                                  core.FieldTypeJSON,
		"costSharing":                           core.FieldTypeJSON,
		"costSharingCollectionReminderEnabled":  core.FieldTypeBool,
		"costSharingNextCollectionReminderDate": core.FieldTypeText,
		"extra":                                 core.FieldTypeJSON,
		"reminderDays":                          core.FieldTypeNumber,
		"repeatReminderEnabled":                 core.FieldTypeBool,
		"repeatReminderInterval":                core.FieldTypeSelect,
		"repeatReminderWindow":                  core.FieldTypeSelect,
		"created":                               core.FieldTypeAutodate,
		"updated":                               core.FieldTypeAutodate,
	})
	assertFields(t, app, "settings", map[string]string{
		"user":     core.FieldTypeRelation,
		"settings": core.FieldTypeJSON,
		"created":  core.FieldTypeAutodate,
		"updated":  core.FieldTypeAutodate,
	})
	assertFields(t, app, authSecurityCollectionName, map[string]string{
		"key":              core.FieldTypeText,
		"turnstileEnabled": core.FieldTypeBool,
		"turnstileSiteKey": core.FieldTypeText,
		"turnstileSecret":  core.FieldTypeText,
		"created":          core.FieldTypeAutodate,
		"updated":          core.FieldTypeAutodate,
	})
	assertFields(t, app, "custom_configs", map[string]string{
		"user":    core.FieldTypeRelation,
		"config":  core.FieldTypeJSON,
		"created": core.FieldTypeAutodate,
		"updated": core.FieldTypeAutodate,
	})
	assertFields(t, app, "subscription_scheduler_states", map[string]string{
		"user":                           core.FieldTypeRelation,
		"autoRenewCount":                 core.FieldTypeNumber,
		"repeatReminderCount":            core.FieldTypeNumber,
		"lastAutoRenewLocalDate":         core.FieldTypeText,
		"nextAutoRenewCheckAtUTC":        core.FieldTypeText,
		"nextDailyNotificationDueAtUTC":  core.FieldTypeText,
		"nextRepeatNotificationDueAtUTC": core.FieldTypeText,
		"created":                        core.FieldTypeAutodate,
		"updated":                        core.FieldTypeAutodate,
	})
	assertFields(t, app, "assets", map[string]string{
		"user":         core.FieldTypeRelation,
		"kind":         core.FieldTypeSelect,
		"file":         core.FieldTypeFile,
		"mimeType":     core.FieldTypeText,
		"sizeBytes":    core.FieldTypeNumber,
		"originalName": core.FieldTypeText,
		"created":      core.FieldTypeAutodate,
		"updated":      core.FieldTypeAutodate,
	})
	assertTextFieldRequired(t, app, "subscriptions", "price", true)
	assertNumberField(t, app, "subscriptions", "reminderDays", false, disabledReminderDays, maxReminderDays)
	assertTextFieldRequired(t, app, "subscriptions", "costSharingNextCollectionReminderDate", false)
	assertTextFieldRequired(t, app, "subscriptions", "startDate", false)
	assertSelectFieldValues(t, app, "subscriptions", "billingCycle", "weekly", "monthly", "quarterly", "semi-annual", "annual", "custom", "one-time")
	assertSelectFieldValues(t, app, "subscriptions", "customCycleUnit", "day", "week", "month", "year")
	assertNumberField(t, app, "subscriptions", "oneTimeTermCount", false, 0, maxReminderDays)
	assertSelectFieldValues(t, app, "subscriptions", "oneTimeTermUnit", "day", "week", "month", "year")
	assertSelectFieldValues(t, app, "subscriptions", "status", "trial", "active", "expired", "paused", "cancelled")
	assertJSONFieldMaxSize(t, app, "subscriptions", "tags", maxSubscriptionTagsFieldSize)
	assertJSONFieldMaxSize(t, app, "subscriptions", "costSharing", 65536)
	assertFileFieldMimeTypes(t, app, "assets", "file", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon")
	assertFields(t, app, "notification_jobs", map[string]string{
		"user":                core.FieldTypeRelation,
		"scheduledLocalDate":  core.FieldTypeText,
		"scheduledLocalTime":  core.FieldTypeText,
		"timeZone":            core.FieldTypeText,
		"scheduledInstantUtc": core.FieldTypeText,
		"status":              core.FieldTypeSelect,
		"attempts":            core.FieldTypeNumber,
		"lastError":           core.FieldTypeText,
		"result":              core.FieldTypeJSON,
		"created":             core.FieldTypeAutodate,
		"updated":             core.FieldTypeAutodate,
	})
	assertFields(t, app, "calendar_feeds", map[string]string{
		"user":           core.FieldTypeRelation,
		"scope":          core.FieldTypeSelect,
		"subscriptionId": core.FieldTypeText,
		"token":          core.FieldTypeText,
		"created":        core.FieldTypeAutodate,
		"updated":        core.FieldTypeAutodate,
	})
	assertFields(t, app, "public_status_pages", map[string]string{
		"user":       core.FieldTypeRelation,
		"token":      core.FieldTypeText,
		"showPrices": core.FieldTypeBool,
		"created":    core.FieldTypeAutodate,
		"updated":    core.FieldTypeAutodate,
	})
	assertFields(t, app, "api_tokens", map[string]string{
		"user":        core.FieldTypeRelation,
		"name":        core.FieldTypeText,
		"tokenHash":   core.FieldTypeText,
		"tokenPrefix": core.FieldTypeText,
		"scopes":      core.FieldTypeJSON,
		"lastUsedAt":  core.FieldTypeText,
		"created":     core.FieldTypeAutodate,
		"updated":     core.FieldTypeAutodate,
	})
	assertMissingField(t, app, "api_tokens", "revokedAt")
	assertFields(t, app, "app_sessions", map[string]string{
		"user":          core.FieldTypeRelation,
		"tokenHash":     core.FieldTypeText,
		"csrfTokenHash": core.FieldTypeText,
		"expiresAt":     core.FieldTypeText,
		"lastSeenAt":    core.FieldTypeText,
		"created":       core.FieldTypeAutodate,
		"updated":       core.FieldTypeAutodate,
	})
	assertFields(t, app, "mfa_totp_credentials", map[string]string{
		"user":             core.FieldTypeRelation,
		"secretCiphertext": core.FieldTypeText,
		"lastAcceptedStep": core.FieldTypeNumber,
		"created":          core.FieldTypeAutodate,
		"updated":          core.FieldTypeAutodate,
	})
	assertFields(t, app, "mfa_recovery_codes", map[string]string{
		"user":     core.FieldTypeRelation,
		"codeHash": core.FieldTypeText,
		"usedAt":   core.FieldTypeText,
		"created":  core.FieldTypeAutodate,
		"updated":  core.FieldTypeAutodate,
	})
	assertFields(t, app, "mfa_auth_tickets", map[string]string{
		"user":              core.FieldTypeRelation,
		"ticketHash":        core.FieldTypeText,
		"expiresAt":         core.FieldTypeText,
		"attempts":          core.FieldTypeNumber,
		"methods":           core.FieldTypeJSON,
		"payloadCiphertext": core.FieldTypeText,
		"created":           core.FieldTypeAutodate,
		"updated":           core.FieldTypeAutodate,
	})
	assertFields(t, app, "passkey_credentials", map[string]string{
		"user":           core.FieldTypeRelation,
		"name":           core.FieldTypeText,
		"credentialId":   core.FieldTypeText,
		"publicKey":      core.FieldTypeText,
		"credentialJson": core.FieldTypeText,
		"counter":        core.FieldTypeNumber,
		"transports":     core.FieldTypeJSON,
		"created":        core.FieldTypeAutodate,
		"updated":        core.FieldTypeAutodate,
	})
	assertFields(t, app, "passkey_challenges", map[string]string{
		"user":            core.FieldTypeRelation,
		"challengeIdHash": core.FieldTypeText,
		"kind":            core.FieldTypeSelect,
		"challenge":       core.FieldTypeText,
		"sessionDataJson": core.FieldTypeText,
		"expiresAt":       core.FieldTypeText,
		"created":         core.FieldTypeAutodate,
		"updated":         core.FieldTypeAutodate,
	})
	assertFields(t, app, "telegram_bot_bindings", map[string]string{
		"user":              core.FieldTypeRelation,
		"chatId":            core.FieldTypeText,
		"botTokenHash":      core.FieldTypeText,
		"webhookSecretHash": core.FieldTypeText,
		"status":            core.FieldTypeSelect,
		"lastUpdateId":      core.FieldTypeNumber,
		"lastUsedAt":        core.FieldTypeText,
		"created":           core.FieldTypeAutodate,
		"updated":           core.FieldTypeAutodate,
	})
	assertSelectFieldValues(t, app, "telegram_bot_bindings", "status", "installing", "installed")

	assertIndex(t, app, "subscriptions", "idx_subscriptions_user")
	assertIndex(t, app, "subscriptions", "idx_subscriptions_user_logo")
	assertIndex(t, app, "subscriptions", "idx_subscriptions_user_auto_renew_due")
	assertIndex(t, app, "subscriptions", "idx_subscriptions_user_reminder_due")
	assertIndex(t, app, "subscriptions", "idx_subscriptions_user_trial_reminder")
	assertIndex(t, app, "subscriptions", "idx_subscriptions_user_repeat_reminder")
	assertIndex(t, app, "subscriptions", "idx_subscriptions_user_repeat_trial_reminder")
	assertIndex(t, app, "subscriptions", "idx_subscriptions_user_cost_sharing_collection_due")
	assertIndex(t, app, "subscriptions", "idx_subscriptions_user_category_order")
	assertIndex(t, app, "subscriptions", "idx_subscriptions_user_billing_cycle_order")
	assertIndex(t, app, "subscriptions", "idx_subscriptions_user_currency_order")
	assertIndex(t, app, "subscriptions", "idx_subscriptions_user_payment_method_order")
	assertIndex(t, app, "subscriptions", "idx_subscriptions_user_pinned_order")
	assertIndex(t, app, "subscriptions", "idx_subscriptions_user_public_hidden_order")
	assertIndex(t, app, "subscriptions", "idx_subscriptions_user_reminder_mode_order")
	assertIndex(t, app, "subscriptions", "idx_subscriptions_user_repeat_reminder_order")
	assertIndexDefinition(t, app, "subscriptions", "idx_subscriptions_user_auto_renew_due", "user, autoRenew, nextBillingDate, id")
	assertIndexDefinition(t, app, "subscriptions", "idx_subscriptions_user_reminder_due", "user, nextBillingDate, id")
	assertIndexDefinition(t, app, "subscriptions", "idx_subscriptions_user_trial_reminder", "user, trialEndDate, id")
	assertIndexDefinition(t, app, "subscriptions", "idx_subscriptions_user_repeat_reminder", "user, repeatReminderEnabled, nextBillingDate, id")
	assertIndexDefinition(t, app, "subscriptions", "idx_subscriptions_user_repeat_trial_reminder", "user, repeatReminderEnabled, status, trialEndDate, id")
	assertIndexDefinition(t, app, "subscriptions", "idx_subscriptions_user_cost_sharing_collection_due", "user, costSharingCollectionReminderEnabled, costSharingNextCollectionReminderDate, id")
	assertIndexDefinition(t, app, "subscriptions", "idx_subscriptions_user_category_order", "user, category, created, id")
	assertIndexDefinition(t, app, "subscriptions", "idx_subscriptions_user_billing_cycle_order", "user, billingCycle, created, id")
	assertIndexDefinition(t, app, "subscriptions", "idx_subscriptions_user_currency_order", "user, currency, created, id")
	assertIndexDefinition(t, app, "subscriptions", "idx_subscriptions_user_payment_method_order", "user, paymentMethod, created, id")
	assertIndexDefinition(t, app, "subscriptions", "idx_subscriptions_user_pinned_order", "user, pinned, created, id")
	assertIndexDefinition(t, app, "subscriptions", "idx_subscriptions_user_public_hidden_order", "user, publicHidden, created, id")
	assertIndexDefinition(t, app, "subscriptions", "idx_subscriptions_user_reminder_mode_order", "user, reminderDays, created, id")
	assertIndexDefinition(t, app, "subscriptions", "idx_subscriptions_user_repeat_reminder_order", "user, repeatReminderEnabled, created, id")
	assertIndex(t, app, "subscription_scheduler_states", "idx_subscription_scheduler_states_user_unique")
	assertIndex(t, app, "settings", "idx_settings_user_unique")
	assertIndex(t, app, authSecurityCollectionName, "idx_auth_security_settings_key_unique")
	assertIndex(t, app, "custom_configs", "idx_custom_configs_user_unique")
	assertIndex(t, app, "notification_jobs", "idx_notification_jobs_user_local_time_unique")
	assertIndex(t, app, "calendar_feeds", "idx_calendar_feeds_user_all_unique")
	assertIndex(t, app, "calendar_feeds", "idx_calendar_feeds_token_unique")
	assertIndex(t, app, "calendar_feeds", "idx_calendar_feeds_user_subscription_unique")
	assertIndex(t, app, "calendar_feeds", "idx_calendar_feeds_user_scope_updated_id")
	assertIndex(t, app, "public_status_pages", "idx_public_status_pages_user_unique")
	assertIndex(t, app, "public_status_pages", "idx_public_status_pages_token_unique")
	assertIndex(t, app, "api_tokens", "idx_api_tokens_user_created")
	assertIndex(t, app, "api_tokens", "idx_api_tokens_token_hash_unique")
	assertMissingIndex(t, app, "api_tokens", "idx_api_tokens_user_revoked")
	assertIndex(t, app, "app_sessions", "idx_app_sessions_token_hash_unique")
	assertIndex(t, app, "app_sessions", "idx_app_sessions_user")
	assertIndex(t, app, "app_sessions", "idx_app_sessions_expires")
	assertIndex(t, app, "mfa_totp_credentials", "idx_mfa_totp_user_unique")
	assertIndex(t, app, "mfa_recovery_codes", "idx_mfa_recovery_user_hash_unique")
	assertIndex(t, app, "mfa_recovery_codes", "idx_mfa_recovery_user_used")
	assertIndex(t, app, "mfa_auth_tickets", "idx_mfa_tickets_hash_unique")
	assertIndex(t, app, "mfa_auth_tickets", "idx_mfa_tickets_user_expires")
	assertIndex(t, app, "passkey_credentials", "idx_passkeys_credential_unique")
	assertIndex(t, app, "passkey_credentials", "idx_passkeys_user")
	assertIndex(t, app, "passkey_challenges", "idx_passkey_challenge_unique")
	assertIndex(t, app, "passkey_challenges", "idx_passkey_challenge_user_kind")
	assertIndex(t, app, "telegram_bot_bindings", "idx_telegram_bot_bindings_user_unique")
	assertIndex(t, app, "telegram_bot_bindings", "idx_telegram_bot_bindings_webhook_secret")
}

func TestEnsureSchemaSelfHealsExistingCollectionsWithoutAutodates(t *testing.T) {
	app := newSchemaTestApp(t)
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}

	subscriptions := core.NewBaseCollection("subscriptions")
	if err := upsertField(subscriptions, userRelation(users)); err != nil {
		t.Fatal(err)
	}
	if err := upsertField(subscriptions, &core.TextField{Name: "name", Required: true}); err != nil {
		t.Fatal(err)
	}
	if err := app.Save(subscriptions); err != nil {
		t.Fatal(err)
	}

	jobs := core.NewBaseCollection("notification_jobs")
	if err := upsertField(jobs, userRelation(users)); err != nil {
		t.Fatal(err)
	}
	if err := upsertField(jobs, &core.TextField{Name: "scheduledInstantUtc", Required: true}); err != nil {
		t.Fatal(err)
	}
	if err := app.Save(jobs); err != nil {
		t.Fatal(err)
	}

	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}

	assertFields(t, app, "subscriptions", map[string]string{
		"created": core.FieldTypeAutodate,
		"updated": core.FieldTypeAutodate,
	})
	assertFields(t, app, "notification_jobs", map[string]string{
		"created": core.FieldTypeAutodate,
		"updated": core.FieldTypeAutodate,
	})
}

func TestBackfillSubscriptionAutoRenewOnlyForcesOneTimeFalse(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	user := core.NewRecord(users)
	user.SetEmail("schema-autorenew@example.com")
	user.SetPassword("password123")
	user.SetVerified(true)
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	subscriptions, err := app.FindCollectionByNameOrId("subscriptions")
	if err != nil {
		t.Fatal(err)
	}

	insert := func(name string, cycle string, autoRenew bool) string {
		t.Helper()
		record := core.NewRecord(subscriptions)
		record.Set("user", user.Id)
		record.Set("name", name)
		record.Set("price", "1")
		record.Set("currency", "USD")
		record.Set("billingCycle", cycle)
		record.Set("category", "productivity")
		record.Set("status", "active")
		record.Set("startDate", "2026-05-14")
		record.Set("nextBillingDate", "2026-06-14")
		record.Set("autoRenew", autoRenew)
		record.Set("autoCalculateNextBillingDate", true)
		record.Set("tags", []string{})
		record.Set("extra", emptyJSONPayload{})
		record.Set("reminderDays", 3)
		record.Set("repeatReminderEnabled", false)
		record.Set("repeatReminderInterval", defaultRepeatReminderInterval)
		record.Set("repeatReminderWindow", defaultRepeatReminderWindow)
		if err := app.SaveNoValidate(record); err != nil {
			t.Fatal(err)
		}
		return record.Id
	}

	manualID := insert("Manual", "monthly", false)
	autoID := insert("Auto", "monthly", true)
	oneTimeID := insert("One Time", "one-time", true)

	if err := backfillSubscriptionAutoRenew(app); err != nil {
		t.Fatal(err)
	}

	assertAutoRenew := func(id string, want bool) {
		t.Helper()
		record, err := app.FindRecordById("subscriptions", id)
		if err != nil {
			t.Fatal(err)
		}
		if got := record.GetBool("autoRenew"); got != want {
			t.Fatalf("autoRenew for %s = %v, want %v", id, got, want)
		}
	}
	assertAutoRenew(manualID, false)
	assertAutoRenew(autoID, true)
	assertAutoRenew(oneTimeID, false)
}

func TestEnsureSchemaSelfHealsSubscriptionLogoURLFieldToText(t *testing.T) {
	app := newSchemaTestApp(t)
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}

	subscriptions := core.NewBaseCollection("subscriptions")
	if err := upsertField(subscriptions, userRelation(users)); err != nil {
		t.Fatal(err)
	}
	if err := upsertField(subscriptions, &core.TextField{Name: "name", Required: true}); err != nil {
		t.Fatal(err)
	}
	if err := upsertField(subscriptions, &core.URLField{Name: "logo"}); err != nil {
		t.Fatal(err)
	}
	if err := upsertField(subscriptions, &core.NumberField{Name: "price"}); err != nil {
		t.Fatal(err)
	}
	if err := upsertField(subscriptions, &core.SelectField{Name: "status", Required: true, Values: []string{"trial", "active", "expired", "paused", "cancelled"}}); err != nil {
		t.Fatal(err)
	}
	if err := app.Save(subscriptions); err != nil {
		t.Fatal(err)
	}
	user := core.NewRecord(users)
	user.SetEmail("schema-logo@example.com")
	user.SetPassword("password123")
	user.SetVerified(true)
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(subscriptions)
	record.Set("user", user.Id)
	record.Set("name", "Logo Field")
	record.Set("status", "active")
	record.Set("logo", "https://example.com/logo.png")
	record.Set("price", 12.5)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}

	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}

	collection, err := app.FindCollectionByNameOrId("subscriptions")
	if err != nil {
		t.Fatal(err)
	}
	field, ok := collection.Fields.GetByName("logo").(*core.TextField)
	if !ok {
		t.Fatalf("expected subscriptions.logo to be text after self-heal, got %T", collection.Fields.GetByName("logo"))
	}
	if field.Max != maxLogoReferenceLength {
		t.Fatalf("subscriptions.logo max = %d, want %d", field.Max, maxLogoReferenceLength)
	}
	savedRecord, err := app.FindRecordById("subscriptions", record.Id)
	if err != nil {
		t.Fatal(err)
	}
	if savedRecord.GetString("logo") != "https://example.com/logo.png" {
		t.Fatalf("expected existing logo value to survive self-heal, got %q", savedRecord.GetString("logo"))
	}
}

func TestEnsureSchemaMigratesLegacySubscriptionPriceNumberFieldToText(t *testing.T) {
	app := newSchemaTestApp(t)
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}

	subscriptions := core.NewBaseCollection("subscriptions")
	if err := upsertField(subscriptions, userRelation(users)); err != nil {
		t.Fatal(err)
	}
	if err := upsertField(subscriptions, &core.TextField{Name: "name", Required: true}); err != nil {
		t.Fatal(err)
	}
	if err := upsertField(subscriptions, &core.TextField{Name: "logo"}); err != nil {
		t.Fatal(err)
	}
	if err := upsertField(subscriptions, &core.NumberField{Name: "price"}); err != nil {
		t.Fatal(err)
	}
	if err := upsertField(subscriptions, &core.SelectField{Name: "status", Required: true, Values: []string{"trial", "active", "expired", "paused", "cancelled"}}); err != nil {
		t.Fatal(err)
	}
	if err := app.Save(subscriptions); err != nil {
		t.Fatal(err)
	}

	user := core.NewRecord(users)
	user.SetEmail("schema-price@example.com")
	user.SetPassword("password123")
	user.SetVerified(true)
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(subscriptions)
	record.Set("user", user.Id)
	record.Set("name", "Legacy Price")
	record.Set("status", "active")
	record.Set("logo", "https://example.com/logo.png")
	record.Set("price", 12.5)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}

	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}

	assertTextFieldRequired(t, app, "subscriptions", "price", true)
	assertTableColumnType(t, app, "subscriptions", "price", "TEXT")
	assertMissingTableColumn(t, app, "subscriptions", legacySubscriptionPriceNumberColumn)
	savedRecord, err := app.FindRecordById("subscriptions", record.Id)
	if err != nil {
		t.Fatal(err)
	}
	if got := savedRecord.GetString("price"); got != "12.5" {
		t.Fatalf("legacy price = %q, want %q", got, "12.5")
	}
}

func TestEnsureSchemaSelfHealsAssetsSvgMimeType(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	collection, err := app.FindCollectionByNameOrId("assets")
	if err != nil {
		t.Fatal(err)
	}
	field, ok := collection.Fields.GetByName("file").(*core.FileField)
	if !ok {
		t.Fatal("expected assets.file to be a file field")
	}
	field.MimeTypes = []string{"image/png", "image/jpeg", "image/webp"}
	if err := app.Save(collection); err != nil {
		t.Fatal(err)
	}

	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}

	assertFileFieldMimeTypes(t, app, "assets", "file", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon")
}

func assertNumberField(t *testing.T, app core.App, collectionName string, fieldName string, required bool, min float64, max float64) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId(collectionName)
	if err != nil {
		t.Fatal(err)
	}
	field, ok := collection.Fields.GetByName(fieldName).(*core.NumberField)
	if !ok {
		t.Fatalf("collection %s field %s is not a number field", collectionName, fieldName)
	}
	if field.Required != required {
		t.Fatalf("collection %s field %s required = %v, want %v", collectionName, fieldName, field.Required, required)
	}
	if field.Min == nil || *field.Min != min {
		t.Fatalf("collection %s field %s min = %v, want %v", collectionName, fieldName, field.Min, min)
	}
	if field.Max == nil || *field.Max != max {
		t.Fatalf("collection %s field %s max = %v, want %v", collectionName, fieldName, field.Max, max)
	}
}

func assertTextFieldRequired(t *testing.T, app core.App, collectionName string, fieldName string, required bool) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId(collectionName)
	if err != nil {
		t.Fatal(err)
	}
	field, ok := collection.Fields.GetByName(fieldName).(*core.TextField)
	if !ok {
		t.Fatalf("collection %s field %s is not a text field", collectionName, fieldName)
	}
	if field.Required != required {
		t.Fatalf("collection %s field %s required = %v, want %v", collectionName, fieldName, field.Required, required)
	}
}

func assertJSONFieldMaxSize(t *testing.T, app core.App, collectionName string, fieldName string, maxSize int64) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId(collectionName)
	if err != nil {
		t.Fatal(err)
	}
	field, ok := collection.Fields.GetByName(fieldName).(*core.JSONField)
	if !ok {
		t.Fatalf("collection %s field %s is not a JSON field", collectionName, fieldName)
	}
	if field.MaxSize != maxSize {
		t.Fatalf("collection %s field %s max size = %d, want %d", collectionName, fieldName, field.MaxSize, maxSize)
	}
}

func assertSelectFieldValues(t *testing.T, app core.App, collectionName string, fieldName string, expected ...string) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId(collectionName)
	if err != nil {
		t.Fatal(err)
	}
	field, ok := collection.Fields.GetByName(fieldName).(*core.SelectField)
	if !ok {
		t.Fatalf("collection %s field %s is not a select field", collectionName, fieldName)
	}
	if len(field.Values) != len(expected) {
		t.Fatalf("collection %s field %s values = %#v, want %#v", collectionName, fieldName, field.Values, expected)
	}
	for i, value := range expected {
		if field.Values[i] != value {
			t.Fatalf("collection %s field %s values = %#v, want %#v", collectionName, fieldName, field.Values, expected)
		}
	}
}

func assertFields(t *testing.T, app core.App, collectionName string, fields map[string]string) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId(collectionName)
	if err != nil {
		t.Fatal(err)
	}
	for name, fieldType := range fields {
		field := collection.Fields.GetByName(name)
		if field == nil {
			t.Fatalf("collection %s is missing field %s", collectionName, name)
		}
		if field.Type() != fieldType {
			t.Fatalf("collection %s field %s type = %s, want %s", collectionName, name, field.Type(), fieldType)
		}
	}
}

func assertMissingField(t *testing.T, app core.App, collectionName string, fieldName string) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId(collectionName)
	if err != nil {
		t.Fatal(err)
	}
	if field := collection.Fields.GetByName(fieldName); field != nil {
		t.Fatalf("collection %s field %s should not exist, got %s", collectionName, fieldName, field.Type())
	}
}

func assertFileFieldMimeTypes(t *testing.T, app core.App, collectionName string, fieldName string, expected ...string) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId(collectionName)
	if err != nil {
		t.Fatal(err)
	}
	field, ok := collection.Fields.GetByName(fieldName).(*core.FileField)
	if !ok {
		t.Fatalf("collection %s field %s is not a file field", collectionName, fieldName)
	}
	for _, mimeType := range expected {
		found := false
		for _, actual := range field.MimeTypes {
			if actual == mimeType {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("collection %s field %s MIME types %#v missing %s", collectionName, fieldName, field.MimeTypes, mimeType)
		}
	}
}

func assertIndex(t *testing.T, app core.App, collectionName string, indexName string) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId(collectionName)
	if err != nil {
		t.Fatal(err)
	}
	for _, index := range collection.Indexes {
		if strings.Contains(index, "`"+indexName+"`") {
			return
		}
	}
	t.Fatalf("collection %s is missing index %s", collectionName, indexName)
}

func assertMissingIndex(t *testing.T, app core.App, collectionName string, indexName string) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId(collectionName)
	if err != nil {
		t.Fatal(err)
	}
	for _, index := range collection.Indexes {
		if strings.Contains(index, "`"+indexName+"`") {
			t.Fatalf("collection %s index %s should not exist: %#v", collectionName, indexName, collection.Indexes)
		}
	}
}

func assertIndexDefinition(t *testing.T, app core.App, collectionName string, indexName string, columns string) {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId(collectionName)
	if err != nil {
		t.Fatal(err)
	}
	expected := "CREATE INDEX `" + indexName + "` ON `" + collectionName + "` (" + columns + ")"
	for _, index := range collection.Indexes {
		if index == expected {
			return
		}
	}
	t.Fatalf("collection %s index %s definition mismatch, want %q in %#v", collectionName, indexName, expected, collection.Indexes)
}

func assertTableColumnType(t *testing.T, app core.App, tableName string, columnName string, expectedType string) {
	t.Helper()
	info, err := app.TableInfo(tableName)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range info {
		if row.Name == columnName {
			if row.Type != expectedType {
				t.Fatalf("table %s column %s type = %q, want %q", tableName, columnName, row.Type, expectedType)
			}
			return
		}
	}
	t.Fatalf("table %s is missing column %s", tableName, columnName)
}

func assertMissingTableColumn(t *testing.T, app core.App, tableName string, columnName string) {
	t.Helper()
	columns, err := app.TableColumns(tableName)
	if err != nil {
		t.Fatal(err)
	}
	for _, column := range columns {
		if column == columnName {
			t.Fatalf("table %s column %s should not exist", tableName, columnName)
		}
	}
}
