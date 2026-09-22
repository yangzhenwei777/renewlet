package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const expectedDemoSubscriptionCount = 100

func newDemoModeTestApp(t *testing.T) (core.App, *core.Record, string) {
	t.Helper()
	// demo 模式测试必须走完整 schema/hooks，让路由和直接 record 写入共享同一套保护。
	t.Setenv(demoModeEnvName, "true")
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	if err := ensureDemoMode(app); err != nil {
		t.Fatal(err)
	}
	user, err := demoModePolicy.FindUser(app)
	if err != nil {
		t.Fatal(err)
	}
	if user == nil {
		t.Fatal("expected demo user to be created")
	}
	token, csrfToken, _, err := createAppSession(app, user.Id)
	if err != nil {
		t.Fatal(err)
	}
	return app, user, routeTestProductSessionAuth(token, csrfToken)
}

func countUserRecords(t *testing.T, app core.App, collection string, userID string) int64 {
	t.Helper()
	total, err := app.CountRecords(collection, dbx.HashExp{"user": userID})
	if err != nil {
		t.Fatal(err)
	}
	return total
}

func TestDemoSubscriptionSeedsUseDeveloperDataAndRollingDates(t *testing.T) {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	later := now.AddDate(0, 0, 9)
	seeds := demoSubscriptionSeeds(now)
	laterSeeds := demoSubscriptionSeeds(later)
	providerBase := strings.TrimRight(mediaResolverBuiltInProviderBase(demoModeLogoProvider), "/")
	expectedCategories := map[string]struct{}{
		"ai_tools":        {},
		"developer_tools": {},
		"productivity":    {},
		"hosting_domains": {},
		"design":          {},
		"security_vpn":    {},
		"business":        {},
	}
	expectedStatuses := map[string]struct{}{
		"active":    {},
		"trial":     {},
		"paused":    {},
		"cancelled": {},
	}
	expectedPaymentMethods := map[string]struct{}{
		"credit_card":   {},
		"paypal":        {},
		"apple_pay":     {},
		"google_pay":    {},
		"bank_transfer": {},
		"debit_card":    {},
	}
	representativeSlugs := map[string]struct{}{
		"chatgpt-plus":                {},
		"claude-pro":                  {},
		"github-copilot-pro":          {},
		"cursor-pro":                  {},
		"vercel-pro":                  {},
		"supabase-pro":                {},
		"cloudflare-workers-paid":     {},
		"tabnine-dev":                 {},
		"testrail-professional-cloud": {},
		"linear-business":             {},
	}

	if len(seeds) != expectedDemoSubscriptionCount {
		t.Fatalf("expected %d developer demo subscriptions, got %d", expectedDemoSubscriptionCount, len(seeds))
	}
	if len(laterSeeds) != len(seeds) {
		t.Fatalf("expected rolling seed count to stay %d, got %d", len(seeds), len(laterSeeds))
	}
	seenSlugs := map[string]struct{}{}
	seenCategories := map[string]struct{}{}
	seenStatuses := map[string]struct{}{}
	seenPaymentMethods := map[string]struct{}{}
	seedBySlug := map[string]demoSubscriptionSeed{}
	for index, seed := range seeds {
		logo := seed.logoURL()
		seedBySlug[seed.Slug] = seed
		seenCategories[seed.Category] = struct{}{}
		seenStatuses[seed.Status] = struct{}{}
		seenPaymentMethods[seed.PaymentMethod] = struct{}{}
		if _, ok := expectedCategories[seed.Category]; !ok {
			t.Fatalf("%s uses non-catalog developer demo category %q", seed.Name, seed.Category)
		}
		if _, ok := expectedStatuses[seed.Status]; !ok {
			t.Fatalf("%s uses unsupported developer demo status %q", seed.Name, seed.Status)
		}
		if _, ok := expectedPaymentMethods[seed.PaymentMethod]; !ok {
			t.Fatalf("%s uses non-catalog developer demo payment method %q", seed.Name, seed.PaymentMethod)
		}
		if seed.Category == "ai-tools" || seed.Category == "dev-tools" || seed.Category == "hosting-edge" || seed.Category == "data-backend" || seed.Category == "design-collaboration" || seed.Category == "observability" || seed.Category == "security-auth" {
			t.Fatalf("%s leaked old demo-only category %q", seed.Name, seed.Category)
		}
		if seed.PaymentMethod == "visa" || seed.PaymentMethod == "bank" {
			t.Fatalf("%s leaked old demo-only payment method %q", seed.Name, seed.PaymentMethod)
		}
		if strings.Contains(strings.ToLower(seed.Name), "renewlet") || strings.Contains(seed.Website, "renewlet.app") {
			t.Fatalf("demo seed must not include Renewlet fake domain data: %#v", seed)
		}
		if seed.Order != index+1 {
			t.Fatalf("%s order should follow catalog position, got %d want %d", seed.Name, seed.Order, index+1)
		}
		if strings.TrimSpace(seed.Slug) == "" {
			t.Fatalf("%s must expose a stable slug", seed.Name)
		}
		if _, duplicate := seenSlugs[seed.Slug]; duplicate {
			t.Fatalf("duplicate demo slug %q", seed.Slug)
		}
		seenSlugs[seed.Slug] = struct{}{}
		if strings.TrimSpace(seed.LogoSlug) == "" && strings.TrimSpace(seed.LogoURL) == "" {
			t.Fatalf("%s must expose either a TheSVG slug or explicit logo URL", seed.Name)
		}
		if seed.LogoURL != "" {
			if logo != seed.LogoURL {
				t.Fatalf("%s explicit logo URL should win, got %q want %q", seed.Name, logo, seed.LogoURL)
			}
		} else {
			if logo != demoTheSVGLogo(seed.LogoSlug) {
				t.Fatalf("%s logo must be generated by the TheSVG helper, got %q", seed.Name, logo)
			}
			if !strings.HasPrefix(logo, providerBase+"/public/icons/") || strings.Contains(logo, "selfhst/icons/svg") {
				t.Fatalf("%s must use TheSVG provider logo, got %q", seed.Name, logo)
			}
		}
		if strings.TrimSpace(logo) == "" {
			t.Fatalf("%s must resolve a logo reference", seed.Name)
		}
		if err := validateOptionalLogoReference(logo); err != nil {
			t.Fatalf("%s logo should pass subscription logo validation: %v", seed.Name, err)
		}
		if seed.AutoRenew {
			t.Fatalf("%s demo seed must not fake user auto-renew authorization", seed.Name)
		}
		if seed.AutoCalculateNextBillingDate {
			t.Fatalf("%s demo seed must keep catalog date distribution instead of recalculating billing date", seed.Name)
		}
		if !strings.HasPrefix(seed.Website, "https://") || !strings.HasPrefix(seed.PricingSource, "https://") {
			t.Fatalf("%s must keep real HTTPS website and pricing source, website=%q pricing=%q", seed.Name, seed.Website, seed.PricingSource)
		}
		if laterSeeds[index].Slug != seed.Slug {
			t.Fatalf("rolling seeds changed order at %d: %q -> %q", index, seed.Slug, laterSeeds[index].Slug)
		}
		if laterSeeds[index].StartDate != addDateOnlyDaysForTest(t, seed.StartDate, 9) {
			t.Fatalf("%s startDate did not roll with reset: %s -> %s", seed.Name, seed.StartDate, laterSeeds[index].StartDate)
		}
		if laterSeeds[index].NextBillingDate != addDateOnlyDaysForTest(t, seed.NextBillingDate, 9) {
			t.Fatalf("%s nextBillingDate did not roll with reset: %s -> %s", seed.Name, seed.NextBillingDate, laterSeeds[index].NextBillingDate)
		}
		if seed.TrialEndDate != "" && laterSeeds[index].TrialEndDate != addDateOnlyDaysForTest(t, seed.TrialEndDate, 9) {
			t.Fatalf("%s trialEndDate did not roll with reset: %s -> %s", seed.Name, seed.TrialEndDate, laterSeeds[index].TrialEndDate)
		}
	}
	assertStringSetContainsAll(t, seenCategories, expectedCategories, "category")
	assertStringSetContainsAll(t, seenStatuses, expectedStatuses, "status")
	assertStringSetContainsAll(t, seenPaymentMethods, expectedPaymentMethods, "payment method")
	assertStringSetContainsAll(t, seedBySlugKeys(seedBySlug), representativeSlugs, "representative slug")

	if got := seedBySlug["chatgpt-plus"].logoURL(); got != demoTheSVGLogo("openai") {
		t.Fatalf("ChatGPT Plus should use TheSVG logo helper, got %q", got)
	}
	if got := seedBySlug["claude-pro"].logoURL(); !strings.Contains(got, "/icons/claude/default.svg") {
		t.Fatalf("Claude Pro should use explicit logo URL override, got %q", got)
	}
	if got := seedBySlug["tabnine-dev"].logoURL(); got != "https://tabnine.com/favicon.ico" {
		t.Fatalf("Tabnine should use explicit favicon override, got %q", got)
	}
}

func seedBySlugKeys(seeds map[string]demoSubscriptionSeed) map[string]struct{} {
	keys := map[string]struct{}{}
	for slug := range seeds {
		keys[slug] = struct{}{}
	}
	return keys
}

func assertStringSetContainsAll(t *testing.T, seen map[string]struct{}, expected map[string]struct{}, label string) {
	t.Helper()
	for value := range expected {
		if _, ok := seen[value]; !ok {
			t.Fatalf("missing expected demo %s %q", label, value)
		}
	}
}

func addDateOnlyDaysForTest(t *testing.T, value string, days int) string {
	t.Helper()
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		t.Fatalf("invalid date-only test value %q: %v", value, err)
	}
	return parsed.AddDate(0, 0, days).Format("2006-01-02")
}

func TestDemoModeCreatesRepairsSeedsAndDisablesSetup(t *testing.T) {
	if demoModePolicy.MaxSubscriptions != 120 {
		t.Fatalf("expected demo subscription quota to keep 100 baseline rows plus 20 visitor rows, got %d", demoModePolicy.MaxSubscriptions)
	}
	app, demo, token := newDemoModeTestApp(t)

	// demo 身份会被启动修复，避免公开演示环境被改成管理员、封禁或弱密码状态。
	if demo.Email() != demoModePolicy.Email || demo.GetString("name") != demoModePolicy.Name {
		t.Fatalf("unexpected demo identity: email=%q name=%q", demo.Email(), demo.GetString("name"))
	}
	if demo.GetString("role") != "user" || demo.GetBool("banned") {
		t.Fatalf("demo user must stay a normal enabled user, role=%q banned=%v", demo.GetString("role"), demo.GetBool("banned"))
	}
	if !demo.ValidatePassword(demoModePolicy.Password) {
		t.Fatal("expected demo password to be restored")
	}

	wantSubscriptions := int64(len(demoSubscriptionSeeds(time.Now())))
	if got := countUserRecords(t, app, "subscriptions", demo.Id); got != wantSubscriptions {
		t.Fatalf("expected %d demo subscriptions, got %d", wantSubscriptions, got)
	}
	assertPersistedDemoDeveloperSubscriptions(t, app, demo.Id)
	if got := countUserRecords(t, app, "settings", demo.Id); got != 1 {
		t.Fatalf("expected one demo settings row, got %d", got)
	}
	settingsRecord, err := app.FindFirstRecordByFilter("settings", "user = {:user}", dbx.Params{"user": demo.Id})
	if err != nil {
		t.Fatal(err)
	}
	demoSettings := mustSettingsFromRecord(t, settingsRecord)
	if demoSettings.LocalePreference != string(autoLocalePreference) {
		t.Fatalf("expected demo locale preference auto, got %q", demoSettings.LocalePreference)
	}
	if !demoSettings.SubscriptionPriceReferenceEnabled || demoSettings.SubscriptionPriceReferenceCurrency != "CNY" {
		t.Fatalf("expected demo subscription price reference to default to CNY, got enabled=%v currency=%q", demoSettings.SubscriptionPriceReferenceEnabled, demoSettings.SubscriptionPriceReferenceCurrency)
	}
	if len(demoSettings.EnabledChannels) != 0 {
		t.Fatalf("expected demo settings not to enable notification channels, got %#v", demoSettings.EnabledChannels)
	}
	if got := countUserRecords(t, app, "custom_configs", demo.Id); got != 0 {
		t.Fatalf("expected demo reset not to seed custom config rows, got %d", got)
	}
	if got := countUserRecords(t, app, "calendar_feeds", demo.Id); got != 0 {
		t.Fatalf("expected demo reset not to pre-generate calendar feeds, got %d", got)
	}
	if got := countUserRecords(t, app, "public_status_pages", demo.Id); got != 0 {
		t.Fatalf("expected demo reset not to pre-generate public status pages, got %d", got)
	}

	// 公开 token 和日历 token 只能由访客显式生成，seed 不能提前创建可分享链接。
	publicStatusCreate := serveTestRequest(t, app, http.MethodPost, "/api/app/public-status-page", `{}`, token)
	if publicStatusCreate.Code != http.StatusOK {
		t.Fatalf("expected demo user to manually generate public status page, got %d: %s", publicStatusCreate.Code, publicStatusCreate.Body.String())
	}
	calendarFeedCreate := serveTestRequest(t, app, http.MethodPost, "/api/app/calendar-feed", `{}`, token)
	if calendarFeedCreate.Code != http.StatusOK {
		t.Fatalf("expected demo user to manually generate calendar feed, got %d: %s", calendarFeedCreate.Code, calendarFeedCreate.Body.String())
	}

	demo.SetPassword("changed-password")
	demo.Set("role", "admin")
	demo.Set("banned", true)
	if err := app.SaveNoValidate(demo); err != nil {
		t.Fatal(err)
	}
	if err := ensureDemoMode(app); err != nil {
		t.Fatal(err)
	}
	repaired, err := demoModePolicy.FindUser(app)
	if err != nil {
		t.Fatal(err)
	}
	if !repaired.ValidatePassword(demoModePolicy.Password) || repaired.GetString("role") != "user" || repaired.GetBool("banned") {
		t.Fatalf("demo repair failed: role=%q banned=%v", repaired.GetString("role"), repaired.GetBool("banned"))
	}

	status := serveTestRequest(t, app, http.MethodGet, "/api/app/status", "", "")
	if status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"setupEnabled":false`) || !strings.Contains(status.Body.String(), `"demoMode":true`) {
		t.Fatalf("expected app status to expose disabled setup and demo mode, got %d: %s", status.Code, status.Body.String())
	}
	setupStatus := serveTestRequest(t, app, http.MethodGet, "/api/app/setup", "", "")
	if setupStatus.Code != http.StatusOK || !strings.Contains(setupStatus.Body.String(), `"setupEnabled":false`) {
		t.Fatalf("expected setup to be disabled in demo mode, got %d: %s", setupStatus.Code, setupStatus.Body.String())
	}
	create := serveTestRequest(t, app, http.MethodPost, "/api/app/setup", `{"name":"Admin","email":"admin@example.com","password":"password123"}`, "")
	if create.Code != http.StatusForbidden {
		t.Fatalf("expected setup create to be forbidden in demo mode, got %d: %s", create.Code, create.Body.String())
	}
}

func TestDemoModeResetOnlyTouchesDemoUserData(t *testing.T) {
	app, demo, _ := newDemoModeTestApp(t)
	other, _ := createRouteTestUser(t, app, "demo-isolation")
	createRouteTestSubscription(t, app, demo.Id, map[string]interface{}{"name": "Visitor Added"})
	createRouteTestSubscription(t, app, other.Id, map[string]interface{}{"name": "Other User"})
	if _, err := ensureGlobalCalendarFeed(app, demo.Id); err != nil {
		t.Fatal(err)
	}
	if _, err := ensurePublicStatusPage(app, demo.Id); err != nil {
		t.Fatal(err)
	}

	// reset 只清演示用户资料；普通用户数据隔离是 demo 模式能跑在线环境的前提。
	if err := demoModePolicy.ResetUserData(app, demo, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	wantDemoSubscriptions := int64(len(demoSubscriptionSeeds(time.Now())))
	if got := countUserRecords(t, app, "subscriptions", demo.Id); got != wantDemoSubscriptions {
		t.Fatalf("expected demo subscriptions to reset to %d, got %d", wantDemoSubscriptions, got)
	}
	assertPersistedDemoDeveloperSubscriptions(t, app, demo.Id)
	if got := countUserRecords(t, app, "custom_configs", demo.Id); got != 0 {
		t.Fatalf("expected demo reset to remove old custom config rows, got %d", got)
	}
	if got := countUserRecords(t, app, "subscriptions", other.Id); got != 1 {
		t.Fatalf("expected other user subscription to remain, got %d", got)
	}
	if got := countUserRecords(t, app, "calendar_feeds", demo.Id); got != 0 {
		t.Fatalf("expected demo reset to delete generated calendar feeds, got %d", got)
	}
	if got := countUserRecords(t, app, "public_status_pages", demo.Id); got != 0 {
		t.Fatalf("expected demo reset to delete generated public status pages, got %d", got)
	}
}

func assertPersistedDemoDeveloperSubscriptions(t *testing.T, app core.App, userID string) {
	t.Helper()
	rows, err := app.FindRecordsByFilter("subscriptions", "user = {:user}", "name", 200, 0, dbx.Params{"user": userID})
	if err != nil {
		t.Fatal(err)
	}
	expectedBySlug := map[string]demoSubscriptionSeed{}
	for _, seed := range demoSubscriptionSeeds(time.Now()) {
		expectedBySlug[seed.Slug] = seed
	}
	if len(rows) != len(expectedBySlug) {
		t.Fatalf("expected %d persisted demo subscriptions, got %d", len(expectedBySlug), len(rows))
	}
	for _, row := range rows {
		name := row.GetString("name")
		extra := demoExtraMapForTest(t, row.Get("extra"))
		slug, _ := extra["slug"].(string)
		expected, ok := expectedBySlug[slug]
		if !ok {
			t.Fatalf("unexpected persisted demo subscription %q with slug %q", name, slug)
		}
		if name != expected.Name {
			t.Fatalf("persisted subscription name mismatch for %q: got %q want %q", slug, name, expected.Name)
		}
		logo := row.GetString("logo")
		if logo != expected.logoURL() {
			t.Fatalf("%s persisted logo must match generated seed logo, got %q", name, logo)
		}
		if row.GetBool("autoRenew") || row.GetBool("autoCalculateNextBillingDate") {
			t.Fatalf("%s must persist demo dates without auto-renew or auto-calculate flags", name)
		}
		if row.GetString("category") == "ai-tools" || row.GetString("category") == "dev-tools" || row.GetString("paymentMethod") == "visa" || row.GetString("paymentMethod") == "bank" {
			t.Fatalf("%s persisted old demo-only enum values: category=%q paymentMethod=%q", name, row.GetString("category"), row.GetString("paymentMethod"))
		}
		order, orderOK := extra["order"].(float64)
		source, _ := extra["source"].(string)
		sourceURL, _ := extra["sourceUrl"].(string)
		pricingSource, _ := extra["pricingSource"].(string)
		planLabel, _ := extra["planLabel"].(string)
		priceBasis, _ := extra["priceBasis"].(string)
		if extra["demo"] != true || !orderOK || int(order) != expected.Order || source != "public-pricing-demo" || sourceURL != expected.Website || pricingSource != expected.PricingSource || extra["priceCheckedAt"] != demoModePriceCheckedAt || planLabel != expected.PlanLabel || priceBasis != expected.PriceBasis {
			t.Fatalf("%s persisted demo extra missing stable metadata: %#v", name, extra)
		}
		snapshot, ok := extra["priceSnapshot"].(map[string]interface{})
		if !ok {
			t.Fatalf("%s persisted demo extra missing price snapshot: %#v", name, extra)
		}
		amount, amountOK := snapshot["amount"].(string)
		if !amountOK || amount != expected.Price || snapshot["currency"] != expected.Currency || snapshot["billingCycle"] != expected.BillingCycle || snapshot["planLabel"] != expected.PlanLabel || snapshot["basis"] != expected.PriceBasis {
			t.Fatalf("%s persisted price snapshot mismatch: %#v", name, snapshot)
		}
	}
}

func demoExtraMapForTest(t *testing.T, value interface{}) map[string]interface{} {
	t.Helper()
	data, err := jsonBytesFromValue(value)
	if err != nil {
		t.Fatalf("demo extra should be readable as JSON: %v", err)
	}
	var out map[string]interface{}
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("demo extra should be a JSON object: %v", err)
	}
	return out
}

func TestDemoModeAllowsNormalSettingsButProtectsExternalIntegrationSettings(t *testing.T) {
	app, demo, token := newDemoModeTestApp(t)

	// 普通展示设置允许保存，外部通知/AI/备份凭据必须禁止，避免公开演示触发真实第三方调用。
	normal := serveTestRequest(t, app, http.MethodPut, "/api/app/settings", `{"themeMode":"light","monthlyBudget":"123"}`, token)
	if normal.Code != http.StatusOK {
		t.Fatalf("expected ordinary settings save to succeed, got %d: %s", normal.Code, normal.Body.String())
	}
	settingsRecord, err := app.FindFirstRecordByFilter("settings", "user = {:user}", dbx.Params{"user": demo.Id})
	if err != nil {
		t.Fatal(err)
	}
	settings := mustSettingsFromRecord(t, settingsRecord)
	if settings.ThemeMode != "light" || settings.MonthlyBudget != "123" {
		t.Fatalf("ordinary settings were not persisted: %#v", settings)
	}

	protected := serveTestRequest(t, app, http.MethodPut, "/api/app/settings", `{"secretUpdates":{"telegramBotToken":{"action":"set","value":"secret"}}}`, token)
	if protected.Code != http.StatusForbidden {
		t.Fatalf("expected protected settings save to be forbidden, got %d: %s", protected.Code, protected.Body.String())
	}
	protectedDiscord := serveTestRequest(t, app, http.MethodPut, "/api/app/settings", `{"secretUpdates":{"discordWebhookUrl":{"action":"set","value":"https://discord.com/api/webhooks/123/secret"},"pushplusToken":{"action":"clear"}}}`, token)
	if protectedDiscord.Code != http.StatusForbidden {
		t.Fatalf("expected Discord/PushPlus settings save to be forbidden, got %d: %s", protectedDiscord.Code, protectedDiscord.Body.String())
	}
	settingsRecord, err = app.FindFirstRecordByFilter("settings", "user = {:user}", dbx.Params{"user": demo.Id})
	if err != nil {
		t.Fatal(err)
	}
	if got := mustSettingsFromRecord(t, settingsRecord).TelegramBotToken; got != "" {
		t.Fatalf("protected setting leaked into storage: %q", got)
	}
	keep := serveTestRequest(t, app, http.MethodPut, "/api/app/settings", `{"themeVariant":"rose","secretUpdates":{"telegramBotToken":{"action":"keep"},"aiRecognition.apiKey":{"action":"keep"}}}`, token)
	if keep.Code != http.StatusOK {
		t.Fatalf("expected keep-only secret mutations to remain ordinary settings updates, got %d: %s", keep.Code, keep.Body.String())
	}

	recordSettings := mustSettingsFromRecord(t, settingsRecord)
	recordSettings.AIRecognition.APIKey = "sk-demo"
	settingsRecord.Set("settings", recordSettings)
	if err := app.Save(settingsRecord); err == nil {
		t.Fatal("expected direct settings record secret mutation to be rejected")
	}

	targets, err := app.FindCollectionByNameOrId("cloud_backup_targets")
	if err != nil {
		t.Fatal(err)
	}
	target := core.NewRecord(targets)
	target.Set("user", demo.Id)
	target.Set("provider", cloudBackupProviderWebDAV)
	if err := app.Save(target); err == nil {
		t.Fatal("expected direct demo cloud backup target write to be rejected")
	}
}

func TestDemoModeProtectsAccountRoutesAndRecordHooks(t *testing.T) {
	app, demo, token := newDemoModeTestApp(t)
	_, adminToken := createRouteTestUser(t, app, "admin")

	password := serveTestRequest(t, app, http.MethodPut, "/api/app/account/password", `{"currentPassword":"renewlet-demo","newPassword":"changed-password"}`, token)
	if password.Code != http.StatusForbidden {
		t.Fatalf("expected demo password route to be forbidden, got %d: %s", password.Code, password.Body.String())
	}

	demo.SetPassword("changed-password")
	if err := app.Save(demo); err == nil {
		t.Fatal("expected direct demo password save to be rejected")
	}
	reloaded, err := demoModePolicy.FindUser(app)
	if err != nil {
		t.Fatal(err)
	}
	reloaded.Set("role", "admin")
	if err := app.Save(reloaded); err == nil {
		t.Fatal("expected direct demo role save to be rejected")
	}
	reloaded, err = demoModePolicy.FindUser(app)
	if err != nil {
		t.Fatal(err)
	}
	// 直接 Save/Delete 和管理员路由都必须被 hook 拦住，不能只保护公开 API。
	if err := app.Delete(reloaded); err == nil {
		t.Fatal("expected demo user delete to be rejected")
	}

	patch := serveTestRequest(t, app, http.MethodPatch, "/api/app/admin/users/"+demo.Id, `{"role":"admin"}`, adminToken)
	if patch.Code != http.StatusForbidden {
		t.Fatalf("expected admin patch of demo user to be forbidden, got %d: %s", patch.Code, patch.Body.String())
	}
	del := serveTestRequest(t, app, http.MethodDelete, "/api/app/admin/users/"+demo.Id, "", adminToken)
	if del.Code != http.StatusForbidden {
		t.Fatalf("expected admin delete of demo user to be forbidden, got %d: %s", del.Code, del.Body.String())
	}
}

func TestDemoModeKeepsAccountSecurityReadOnly(t *testing.T) {
	app, _, token := newDemoModeTestApp(t)

	for _, tc := range []struct {
		name   string
		target string
	}{
		{name: "mfa status", target: "/api/app/auth/mfa/status"},
		{name: "passkey list", target: "/api/app/auth/passkeys"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := serveTestRequest(t, app, http.MethodGet, tc.target, "", token)
			if res.Code != http.StatusOK {
				t.Fatalf("expected demo account security read to succeed, got %d: %s", res.Code, res.Body.String())
			}
		})
	}

	// 身份验证器和通行密钥是共享 demo 账号的登录门槛，演示访客只能浏览，不能改写这些敏感账号安全能力。
	for _, tc := range []struct {
		name   string
		target string
		body   string
	}{
		{name: "totp setup", target: "/api/app/auth/mfa/totp/setup", body: `{}`},
		{name: "totp enable", target: "/api/app/auth/mfa/totp/enable", body: `{"setupId":"setup","code":"000000","currentPassword":"renewlet-demo"}`},
		{name: "recovery regenerate", target: "/api/app/auth/mfa/recovery/regenerate", body: `{"currentPassword":"renewlet-demo"}`},
		{name: "mfa disable", target: "/api/app/auth/mfa/disable", body: `{"currentPassword":"renewlet-demo"}`},
		{name: "passkey register options", target: "/api/app/auth/passkeys/register/options", body: `{"name":"Demo","currentPassword":"renewlet-demo"}`},
		{name: "passkey register verify", target: "/api/app/auth/passkeys/register/verify", body: `{"challengeId":"challenge","name":"Demo","response":{}}`},
		{name: "passkey delete", target: "/api/app/auth/passkeys/pkey_demo/delete", body: `{"currentPassword":"renewlet-demo"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := serveTestRequest(t, app, http.MethodPost, tc.target, tc.body, token)
			if res.Code != http.StatusForbidden {
				t.Fatalf("expected demo account security mutation to be forbidden, got %d: %s", res.Code, res.Body.String())
			}
		})
	}

	_, normalToken := createRouteTestUser(t, app, "normal-account-security")
	normalSetup := serveTestRequest(t, app, http.MethodPost, "/api/app/auth/mfa/totp/setup", `{}`, normalToken)
	if normalSetup.Code == http.StatusForbidden {
		t.Fatalf("normal user should not be blocked by demo account security guard: %s", normalSetup.Body.String())
	}
}

func TestDemoModeBlocksExternalSideEffectsButNotNormalUsers(t *testing.T) {
	app, _, token := newDemoModeTestApp(t)

	// 这些入口会触发外发请求或云端状态变化，demo 用户只能浏览，不能替部署者发送真实请求。
	for _, tc := range []struct {
		name   string
		method string
		target string
		body   string
	}{
		{name: "notification test", method: http.MethodPost, target: "/api/app/notifications/test", body: `{}`},
		{name: "notification run", method: http.MethodPost, target: "/api/app/notifications/run", body: `{}`},
		{name: "ai model list", method: http.MethodPost, target: "/api/app/ai/models/list", body: `{}`},
		{name: "ai test", method: http.MethodPost, target: "/api/app/ai/subscriptions/test", body: `{}`},
		{name: "ai recognize", method: http.MethodPost, target: "/api/app/ai/subscriptions/recognize", body: `{}`},
		{name: "ai recognize stream", method: http.MethodPost, target: "/api/app/ai/subscriptions/recognize/stream", body: `{}`},
		{name: "cloud backups list", method: http.MethodGet, target: "/api/app/cloud-backups?provider=webdav"},
		{name: "cloud backup config update", method: http.MethodPut, target: "/api/app/cloud-backup/config", body: `{}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := serveTestRequest(t, app, tc.method, tc.target, tc.body, token)
			if res.Code != http.StatusForbidden {
				t.Fatalf("expected demo side effect to be forbidden, got %d: %s", res.Code, res.Body.String())
			}
		})
	}

	_, normalToken := createRouteTestUser(t, app, "normal-side-effect")
	res := serveTestRequest(t, app, http.MethodGet, "/api/app/cloud-backups?provider=webdav", "", normalToken)
	if res.Code == http.StatusForbidden {
		t.Fatalf("normal user should not be blocked by demo guard: %s", res.Body.String())
	}
}

func TestDemoModeEnforcesSubscriptionAndAssetQuota(t *testing.T) {
	original := demoModePolicy
	demoModePolicy.MaxSubscriptions = len(demoSubscriptionSeeds(time.Now()))
	demoModePolicy.MaxAssets = 0
	t.Cleanup(func() { demoModePolicy = original })

	app, _, token := newDemoModeTestApp(t)

	create := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions", subscriptionCreateBody("Over Quota"), token)
	if create.Code != http.StatusBadRequest {
		t.Fatalf("expected demo subscription quota to reject create, got %d: %s", create.Code, create.Body.String())
	}
	upload := serveMultipartTestRequest(
		t,
		app,
		"/api/app/assets",
		token,
		map[string]string{"kind": "logo"},
		"file",
		"logo.svg",
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`,
	)
	if upload.Code != http.StatusBadRequest {
		t.Fatalf("expected demo asset quota to reject upload, got %d: %s", upload.Code, upload.Body.String())
	}
}

func TestDemoModeCronsSkipDemoUser(t *testing.T) {
	app, demo, _ := newDemoModeTestApp(t)

	// 自动续订和通知 cron 都要跳过 demo 用户，避免 seed 数据随时间漂移或产生历史噪声。
	renewal, err := renewAutoSubscriptionsForAllUsers(app, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if renewal.UsersProcessed != 0 || renewal.SubscriptionsUpdated != 0 {
		t.Fatalf("expected renewal maintenance to skip demo user, got %#v", renewal)
	}

	cron, err := runNotificationCron(app, notificationCronOptions{Force: true, DryRun: true, Now: time.Now().UTC()})
	if err != nil {
		t.Fatal(err)
	}
	if cron.Processed != 1 || cron.Skipped != 1 || len(cron.Results) != 1 || cron.Results[0].UserID != demo.Id || cron.Results[0].Reason != "demo_user" {
		t.Fatalf("expected notification cron to skip demo user, got %#v", cron)
	}
}
