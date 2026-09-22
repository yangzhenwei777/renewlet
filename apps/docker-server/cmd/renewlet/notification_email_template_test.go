package main

// Go 邮件模板测试保护与 Worker/shared 邮件语义一致的 HTML/Text fallback、CTA、安全转义和服务端 i18n key。

import (
	"fmt"
	"math"
	"strings"
	"testing"
	"time"
)

func TestBuildEmailHTMLMessageRendersModernLightOnlyReminderTemplate(t *testing.T) {
	t.Setenv("APP_URL", "")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceZhCN)
	settings.ShowExpired = true
	settings.Timezone = "Asia/Shanghai"
	settings.ThemeVariant = "ocean"

	// 邮件 HTML 需要兼容保守客户端，table 布局和内联样式比普通 Web CSS 更重要。
	message := buildDueNotificationForLocalDate("2026-05-14", time.Date(2026, 5, 14, 1, 2, 3, 0, time.UTC), settings, []notificationSubscription{
		{ID: "renewal", Name: "Renewal", Price: "18", Currency: "CNY", Status: "active", NextBillingDate: "2026-05-17", ReminderDays: 3},
		{ID: "trial", Name: "Trial", Price: "9.9", Currency: "USD", Status: "trial", NextBillingDate: "2026-06-01", TrialEndDate: "2026-05-15", ReminderDays: 1},
		{ID: "expired", Name: "Expired", Price: "12", Currency: "EUR", Status: "active", NextBillingDate: "2026-05-01", ReminderDays: 7},
	}, true, accountContentLocale(settings))

	body := mustBuildEmailHTML(t, settings, message)

	assertContainsAll(t, body,
		`<table role="presentation"`,
		`width="600"`,
		`class="email-container" width="600"`,
		`style="width:100%; max-width:600px;`,
		`style="`,
		`<html lang="zh-CN">`,
		`<meta name="color-scheme" content="light only">`,
		`<meta name="supported-color-schemes" content="light">`,
		"Renewlet",
		"<title>Renewlet 订阅提醒</title>",
		`class="email-summary-panel"`,
		`class="email-summary-panel" style="width:100%; border-collapse:separate; border-spacing:0; background:#F8FAF9; border:1px solid #E6EAE8; border-radius:12px;"`,
		`class="email-group-card"`,
		"今日提醒",
		"提醒项目",
		"即将续费",
		"试用结束",
		"已过期",
		"Renewal",
		">18</p>",
		">CNY</p>",
		"2026-05-17",
		"扣费日期 · 2026-05-17 · 提前 3 天提醒",
		`width="96"`,
		emailThemeFromSettings(settings).Primary,
		`border-radius:20px`,
		`border-radius:12px`,
		`.email-outer-pad { padding:28px 0 !important; }`,
		`.email-main-card { border-left:0 !important; border-right:0 !important; border-radius:0 !important; }`,
		`class="email-main-card"`,
		`padding-bottom:36px`,
		"#F5F7F6",
		"#FFFFFF",
		"#F8FAF9",
		"#E6EAE8",
		"#0F172A",
		"#64748B",
	)
	if got := strings.Count(body, "Renewlet 订阅提醒"); got != 1 {
		t.Fatalf("expected reminder title to appear only in document title, got %d\n%s", got, body)
	}
	if got := strings.Count(body, `font-size:13px; line-height:20px;">你有 3 项订阅提醒需要查看。</div>`); got != 1 {
		t.Fatalf("expected visible reminder summary detail once, got %d\n%s", got, body)
	}
	assertEmailBrand(t, body)
	assertNotContainsAny(t, body, `<h1 class="email-h1"`, `class="email-px email-muted"`, `class="email-message-panel"`)
	assertNotContainsAny(t, body, `class="email-stack"`, `class="email-amount"`, `padding:4px 8px; border-radius:6px;`)
	assertNotContainsAny(t, body, `email-card-bottom-safe-area`)
	assertNotContainsAny(t, body, "display:flex", "display: flex", "display:grid", "display: grid", "ZgotmplZ", "light dark")
	assertNotContainsAny(t, body,
		`email-ledger`,
		`@media (prefers-color-scheme: dark)`,
		"#0C0E12",
		"#13161B",
		"#23272E",
		"#1F2229",
		`<img`,
		`<svg`,
		`background-image`,
		`logo.svg`,
		`cid:`,
	)
	if len(body) >= emailMaxHTMLBytes {
		t.Fatalf("expected email html below clipping guard, got %d bytes", len(body))
	}
}

func TestBuildEmailHTMLMessageRendersLongReminderListAsCompactLedgerRows(t *testing.T) {
	t.Setenv("APP_URL", "")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceZhCN)

	items := make([]notificationContentItem, 0, 43)
	for i := 1; i <= 43; i++ {
		items = append(items, notificationContentItem{
			Type:         "renewal",
			Name:         fmt.Sprintf("Ledger Subscription %d", i),
			Price:        fmt.Sprintf("%d", i),
			Currency:     "CNY",
			TargetDate:   "2026-05-17",
			ReminderDays: 3,
		})
	}
	message := notificationMessage{
		Title:      "Renewlet 订阅提醒",
		Content:    "即将续费：Renewlet",
		Timestamp:  "2026-05-14 08:00:00 Asia/Shanghai",
		Items:      items,
		HasPayload: true,
	}

	body := mustBuildEmailHTML(t, settings, message)

	if len(body) >= emailMaxHTMLBytes {
		t.Fatalf("expected full ledger email below clipping guard, got %d bytes", len(body))
	}
	if got := strings.Count(body, "Ledger Subscription"); got != 43 {
		t.Fatalf("expected all 43 reminder rows, got %d\n%s", got, body)
	}
	if got := strings.Count(body, `font-size:13px; line-height:20px;">你有 43 项订阅提醒需要查看。</div>`); got != 1 {
		t.Fatalf("expected visible reminder summary detail once, got %d\n%s", got, body)
	}
	assertContainsAll(t, body,
		"Ledger Subscription 43",
		"扣费日期 · 2026-05-17 · 提前 3 天提醒",
		">43</p>",
		">CNY</p>",
		`class="email-group-card"`,
		`width="96"`,
	)
	assertNotContainsAny(t, body,
		`class="email-message-panel"`,
		"内容较长",
		`class="email-stack"`,
		`class="email-amount"`,
		`padding:4px 8px; border-radius:6px;`,
		`email-card-bottom-safe-area`,
	)
}

func TestBuildEmailHTMLMessageRendersCostSharingCollectionReminder(t *testing.T) {
	t.Setenv("APP_URL", "")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceZhCN)
	message := notificationMessage{
		Title:     "Renewlet 订阅提醒",
		Content:   "家庭共享收款：Family Plan",
		Timestamp: "2026-05-14 08:00:00 Asia/Shanghai",
		Items: []notificationContentItem{{
			Type:         "costSharing",
			Name:         "Family Plan",
			Price:        "30",
			Currency:     "USD",
			TargetDate:   "2026-05-17",
			ReminderDays: 3,
			CostSharing: &notificationCostSharingPayload{
				MemberName: "Partner",
				Amount:     "10",
				Currency:   "USD",
			},
		}},
		HasPayload: true,
	}

	body := mustBuildEmailHTML(t, settings, message)

	assertContainsAll(t, body,
		"家庭共享收款",
		"收款日期 · 2026-05-17 · 向 Partner 收款，提前 3 天提醒",
		">10</p>",
		">USD</p>",
	)
}

func TestBuildEmailHTMLMessageRendersEnglishTestNotification(t *testing.T) {
	t.Setenv("APP_URL", "")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceEnUS)
	settings.Timezone = "UTC"

	message := buildTestNotification(time.Date(2026, 5, 14, 1, 2, 3, 0, time.UTC), settings, accountContentLocale(settings))
	body := mustBuildEmailHTML(t, settings, message)

	assertContainsAll(t, body,
		`<html lang="en-US">`,
		"Renewlet test notification",
		"Channel check",
		"If you received this message",
		"Generated at",
	)
	assertEmailBrand(t, body)
	assertNotContainsAny(t, body, `<h1 class="email-h1"`, `class="email-message-panel"`, `class="email-group-card"`, "email-ledger", "Reminder items")
	assertContainsAll(t, body, `padding-bottom:36px`)
	assertNotContainsAny(t, body, `email-card-bottom-safe-area`)
}

func TestBuildEmailHTMLMessageRendersTestStatusWithoutDuplicateMessagePanel(t *testing.T) {
	t.Setenv("APP_URL", "")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceZhCN)
	message := buildTestNotification(time.Date(2026, 5, 14, 1, 2, 3, 0, time.UTC), settings, accountContentLocale(settings))
	body := mustBuildEmailHTML(t, settings, message)

	assertContainsAll(t, body, "<title>Renewlet 测试通知</title>", "配置检查", `>0 <span`, "如果你收到了这条消息")
	assertContainsAll(t, body, `padding-bottom:36px`)
	assertEmailBrand(t, body)
	assertNotContainsAny(t, body, `<h1 class="email-h1"`, "消息内容", `class="email-message-panel"`, `class="email-group-card"`, `email-card-bottom-safe-area`, "email-ledger")
}

func TestBuildEmailHTMLMessageRendersReminderCTAFromAppURL(t *testing.T) {
	t.Setenv("APP_URL", "https://renewlet.example/app/")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceZhCN)
	message := buildDueNotificationForLocalDate("2026-05-14", time.Date(2026, 5, 14, 1, 2, 3, 0, time.UTC), settings, []notificationSubscription{
		{ID: "renewal", Name: "Renewal", Price: "18", Currency: "CNY", Status: "active", NextBillingDate: "2026-05-17", ReminderDays: 3},
	}, true, accountContentLocale(settings))

	body := mustBuildEmailHTML(t, settings, message)

	assertContainsAll(t, body, `href="https://renewlet.example/app/subscriptions"`, "查看订阅", `line-height:48px`)
	assertNotContainsAny(t, body, "打开通知设置", `padding-bottom:36px`, `email-card-bottom-safe-area`)
	if got := strings.Count(body, "<a href="); got != 1 {
		t.Fatalf("expected a single CTA link, got %d\n%s", got, body)
	}
}

func TestBuildEmailHTMLMessageRendersSettingsCTAForTestNotification(t *testing.T) {
	t.Setenv("APP_URL", "https://renewlet.example")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceEnUS)
	message := buildTestNotification(time.Date(2026, 5, 14, 1, 2, 3, 0, time.UTC), settings, accountContentLocale(settings))

	body := mustBuildEmailHTML(t, settings, message)

	assertContainsAll(t, body, `href="https://renewlet.example/settings"`, "Open notification settings")
	assertNotContainsAny(t, body, "View subscriptions", `padding-bottom:36px`, `email-card-bottom-safe-area`)
	if got := strings.Count(body, "<a href="); got != 1 {
		t.Fatalf("expected a single CTA link, got %d\n%s", got, body)
	}
}

func TestBuildEmailHTMLMessageOmitsCTAForInvalidAppURL(t *testing.T) {
	t.Setenv("APP_URL", "javascript:alert(1)")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceZhCN)
	message := buildTestNotification(time.Date(2026, 5, 14, 1, 2, 3, 0, time.UTC), settings, accountContentLocale(settings))

	body := mustBuildEmailHTML(t, settings, message)

	assertNotContainsAny(t, body, "<a href=", "查看订阅", "打开通知设置", "javascript:alert")
	assertContainsAll(t, body, `padding-bottom:36px`)
	assertNotContainsAny(t, body, `email-card-bottom-safe-area`)
}

func TestBuildEmailHTMLMessageEscapesUserContentAndOmitsLogoURL(t *testing.T) {
	t.Setenv("APP_URL", "")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceZhCN)
	message := notificationMessage{
		Title:     `<script>alert("title")</script>`,
		Content:   "Line <b>one</b>\nLine two",
		Timestamp: `2026-05-14 08:00:00 Asia/Shanghai`,
		Items: []notificationContentItem{{
			Type:         "renewal",
			Name:         `<img src=x onerror=alert(1)>`,
			LogoURL:      "https://cdn.example.com/private-logo.png",
			Price:        "8",
			Currency:     `<USD>`,
			TargetDate:   `2026-05-17`,
			ReminderDays: 3,
		}},
		HasPayload: true,
	}

	body := mustBuildEmailHTML(t, settings, message)

	assertContainsAll(t, body,
		`&lt;script&gt;alert(&#34;title&#34;)&lt;/script&gt;`,
		`&lt;img src=x onerror=alert(1)&gt;`,
		`&lt;USD&gt;`,
	)
	assertNotContainsAny(t, body, "<script", "</script>", "<img", "https://cdn.example.com/private-logo.png")
}

func TestBuildEmailHTMLMessageEscapesPlainContentLines(t *testing.T) {
	t.Setenv("APP_URL", "")
	settings := defaultAppSettings()
	message := notificationMessage{
		Title:      "Renewlet 测试通知",
		Content:    "Line <b>one</b>\nLine two",
		Timestamp:  "2026-05-14 08:00:00 UTC",
		Items:      []notificationContentItem{},
		HasPayload: false,
	}

	body := mustBuildEmailHTML(t, settings, message)

	assertContainsAll(t, body, `Line &lt;b&gt;one&lt;/b&gt;<br>Line two`)
	assertNotContainsAny(t, body, "<b>one</b>")
}

func TestBuildEmailHTMLMessageRendersEmptyNotificationContent(t *testing.T) {
	t.Setenv("APP_URL", "")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceEnUS)
	message := notificationMessage{
		Title:      "Renewlet subscription reminder",
		Content:    "No subscriptions need reminders today.",
		Timestamp:  "2026-05-14 08:00:00 UTC",
		Items:      []notificationContentItem{},
		HasPayload: false,
	}

	body := mustBuildEmailHTML(t, settings, message)

	assertContainsAll(t, body,
		"Message",
		"No reminders",
		`class="email-message-panel"`,
		`padding-bottom:36px`,
		"No subscriptions need reminders today.",
	)
	assertEmailBrand(t, body)
	assertNotContainsAny(t, body, "Reminder items", `class="email-group-card"`, `email-card-bottom-safe-area`, "email-ledger")
}

func TestBuildEmailHTMLMessageCapsLargeHTMLBody(t *testing.T) {
	t.Setenv("APP_URL", "")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceZhCN)
	// 邮件客户端常按体积截断 HTML；超长通知必须降级到 compact 视图，而不是继续膨胀完整列表。
	items := make([]notificationContentItem, 0, 800)
	for i := 0; i < 800; i++ {
		items = append(items, notificationContentItem{
			Type:         "renewal",
			Name:         "Very Long Subscription Name",
			Price:        "18",
			Currency:     "CNY",
			TargetDate:   "2026-05-17",
			ReminderDays: 3,
		})
	}
	message := notificationMessage{
		Title:      "Renewlet 订阅提醒",
		Content:    strings.Repeat("即将续费：Renewlet\n", 2000),
		Timestamp:  "2026-05-14 08:00:00 UTC",
		Items:      items,
		HasPayload: true,
	}

	body := mustBuildEmailHTML(t, settings, message)

	if len(body) >= emailMaxHTMLBytes {
		t.Fatalf("expected compact email html below clipping guard, got %d bytes", len(body))
	}
	assertContainsAll(t, body, "内容较长", "消息内容", "提醒项目", ">800</strong>")
	assertContainsAll(t, body, `class="email-message-panel"`, `padding-bottom:36px`)
	assertEmailBrand(t, body)
	assertNotContainsAny(t, body, `class="email-group-card"`, `email-card-bottom-safe-area`)
}

func TestEmailThemeFromSettingsMapsVariantsAndCustomColor(t *testing.T) {
	settings := defaultAppSettings()
	settings.ThemeVariant = "rose"
	if got, want := emailThemeFromSettings(settings).Primary, hslToHex(340, 75, 50); got != want {
		t.Fatalf("expected rose primary %s, got %s", want, got)
	}

	settings.ThemeVariant = "custom"
	settings.ThemeCustomColor = themeCustomColor{H: 210, S: 90, L: 45}
	if got, want := emailThemeFromSettings(settings).Primary, hslToHex(210, 90, 45); got != want {
		t.Fatalf("expected custom primary %s, got %s", want, got)
	}

	settings.ThemeCustomColor = themeCustomColor{H: math.NaN(), S: 90, L: 45}
	if got, want := emailThemeFromSettings(settings).Primary, hslToHex(160, 84, 39); got != want {
		t.Fatalf("expected invalid custom color to fall back to emerald %s, got %s", want, got)
	}
}

func TestEmailThemesRenderWithoutTemplateCSSSanitizerFailures(t *testing.T) {
	t.Setenv("APP_URL", "https://renewlet.example")
	for _, variant := range []string{"emerald", "ocean", "sunset", "lavender", "rose", "custom"} {
		t.Run(variant, func(t *testing.T) {
			settings := defaultAppSettings()
			settings.ThemeVariant = variant
			if variant == "custom" {
				settings.ThemeCustomColor = themeCustomColor{H: 210, S: 90, L: 45}
			}
			body := mustBuildEmailHTML(t, settings, buildTestNotification(time.Date(2026, 5, 14, 1, 2, 3, 0, time.UTC), settings, accountContentLocale(settings)))

			assertContainsAll(t, body, emailThemeFromSettings(settings).Primary)
			assertNotContainsAny(t, body, "ZgotmplZ")
		})
	}
}

func TestServerI18nCatalogsHaveSameKeysAndNoEmptyValues(t *testing.T) {
	base := serverI18nCatalogs[defaultAppLocale]

	for locale, catalog := range serverI18nCatalogs {
		if len(catalog) != len(base) {
			t.Fatalf("expected locale catalogs to have same key count, %s=%d %s=%d", defaultAppLocale, len(base), locale, len(catalog))
		}
		for key := range base {
			value, ok := catalog[key]
			if !ok {
				t.Fatalf("expected %s catalog to contain key %q", locale, key)
			}
			if strings.TrimSpace(value) == "" {
				t.Fatalf("expected %s catalog key %q to be non-empty", locale, key)
			}
		}
		for key := range catalog {
			if _, ok := base[key]; !ok {
				t.Fatalf("expected %s catalog to contain key %q", defaultAppLocale, key)
			}
		}
	}
}

func TestEmailPlainTextFallbackContentRemainsAvailable(t *testing.T) {
	message := notificationMessage{
		Title:     "Renewlet subscription reminder",
		Content:   "Upcoming renewals:\n- Renewal: 2026-05-17, 18 CNY (3 days before)",
		Timestamp: "2026-05-14 08:00:00 UTC",
	}

	plain := buildEmailTextBody(message)
	assertContainsAll(t, plain, "Upcoming renewals", "2026-05-14 08:00:00 UTC")
}

func mustBuildEmailHTML(t *testing.T, settings appSettings, message notificationMessage) string {
	t.Helper()
	body, err := buildEmailHTMLMessage(settings, message, accountContentLocale(settings))
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func assertContainsAll(t *testing.T, body string, parts ...string) {
	t.Helper()
	for _, part := range parts {
		if !strings.Contains(body, part) {
			t.Fatalf("expected body to contain %q\n%s", part, body)
		}
	}
}

func assertNotContainsAny(t *testing.T, body string, parts ...string) {
	t.Helper()
	for _, part := range parts {
		if strings.Contains(body, part) {
			t.Fatalf("expected body not to contain %q\n%s", part, body)
		}
	}
}

func assertEmailBrand(t *testing.T, body string) {
	t.Helper()
	assertContainsAll(t, body,
		`class="email-brand-lockup"`,
		`class="email-brand-lockup-mark"`,
		"Renewlet",
		"#111720",
		"#26313D",
		"#F8FAFC",
		"#10B981",
	)
	assertNotContainsAny(t, body, `class="email-brand-mark"`, ">R</td>", ">R</div>", "logo.svg", "cid:")
}
