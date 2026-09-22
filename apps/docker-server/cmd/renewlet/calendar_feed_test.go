package main

// 日历 Feed 测试保护登录态管理 API、公开 ICS bearer token、scope 隔离和撤销语义。
// 外部日历客户端不带登录态，所以这些用例必须证明 token 是唯一公开读取入口。

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func TestCalendarFeedLifecycleAndICSRoute(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "calendar")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceEnUS)
	settings.Timezone = "UTC"
	settings.NotificationReminderDays = 5
	createCalendarFeedTestSettings(t, app, user, settings)
	createCalendarFeedTestCustomConfig(t, app, user.Id)
	createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:            "Active Plan",
		Price:           "12.5",
		BillingCycle:    "monthly",
		Category:        "developer_tools",
		Status:          "active",
		PaymentMethod:   "credit_card",
		NextBillingDate: "2099-06-02",
		Website:         "https://example.com/active",
		Notes:           "Team, shared; admin",
		ReminderDays:    inheritReminderDays,
	})
	createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{Name: "Quiet Plan", BillingCycle: "monthly", Status: "active", NextBillingDate: "2099-06-06", ReminderDays: disabledReminderDays})
	createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{Name: "Paused Plan", BillingCycle: "monthly", Status: "paused", NextBillingDate: "2099-06-03"})
	createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{Name: "Cancelled Plan", BillingCycle: "monthly", Status: "cancelled", NextBillingDate: "2099-06-03"})
	createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{Name: "Expired Plan", BillingCycle: "monthly", Status: "expired", NextBillingDate: "2099-06-03"})
	createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{Name: "One Time Plan", BillingCycle: "one-time", Status: "active", NextBillingDate: "2099-06-04"})
	createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{Name: "Fixed Term Plan", BillingCycle: "one-time", OneTimeTermCount: 6, OneTimeTermUnit: "month", Status: "active", NextBillingDate: "2099-06-05"})
	createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{Name: "Past Plan", BillingCycle: "monthly", Status: "active", NextBillingDate: "2000-01-01"})

	statusRes := serveTestRequest(t, app, http.MethodGet, "/api/app/calendar-feed", "", token)
	if statusRes.Code != http.StatusOK || !strings.Contains(statusRes.Body.String(), `"enabled":false`) {
		t.Fatalf("expected disabled calendar feed status, got %d: %s", statusRes.Code, statusRes.Body.String())
	}

	invalidRes := serveTestRequest(t, app, http.MethodPost, "/api/app/calendar-feed", `{"token":"leak"}`, token)
	if invalidRes.Code != http.StatusBadRequest {
		t.Fatalf("expected calendar feed create to reject unknown fields, got %d: %s", invalidRes.Code, invalidRes.Body.String())
	}

	createRes := serveTestRequest(t, app, http.MethodPost, "/api/app/calendar-feed", `{}`, token)
	if createRes.Code != http.StatusOK {
		t.Fatalf("expected calendar feed create 200, got %d: %s", createRes.Code, createRes.Body.String())
	}
	if got := createRes.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("expected calendar feed create no-store, got %q", got)
	}
	createBody := decodeAPISuccessDataForTest[calendarFeedCreateResponse](t, createRes.Body.Bytes())
	if !createBody.CalendarFeed.Enabled || createBody.CalendarFeed.FeedURL == "" {
		t.Fatalf("unexpected create response: %#v", createBody)
	}
	tokenValue := calendarFeedTokenFromURL(t, createBody.CalendarFeed.FeedURL)
	if tokenValue == "" {
		t.Fatal("expected calendar feed URL token")
	}

	statusRes = serveTestRequest(t, app, http.MethodGet, "/api/app/calendar-feed", "", token)
	if statusRes.Code != http.StatusOK || !strings.Contains(statusRes.Body.String(), createBody.CalendarFeed.FeedURL) || !strings.Contains(statusRes.Body.String(), `"enabled":true`) {
		t.Fatalf("expected enabled status with feedUrl, got %d: %s", statusRes.Code, statusRes.Body.String())
	}
	if got := statusRes.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("expected calendar feed status no-store, got %q", got)
	}

	icsRes := serveTestRequest(t, app, http.MethodGet, calendarFeedRequestTarget(t, createBody.CalendarFeed.FeedURL), "", "")
	if icsRes.Code != http.StatusOK {
		t.Fatalf("expected calendar feed ICS 200, got %d: %s", icsRes.Code, icsRes.Body.String())
	}
	ics := icsRes.Body.String()
	assertCalendarFeedLineEndings(t, ics)
	unfoldedICS := unfoldCalendarTestICS(ics)
	for _, expected := range []string{
		"BEGIN:VCALENDAR",
		"NAME:Renewlet renewal calendar",
		"SOURCE;VALUE=URI:",
		"BEGIN:VEVENT",
		"UID:renewlet-renewal-",
		"UID:renewlet-expiry-",
		"DTSTART;VALUE=DATE:20990602",
		"DTEND;VALUE=DATE:20990603",
		"SUMMARY:Active Plan",
		"SUMMARY:Fixed Term Plan",
		"SUMMARY:Quiet Plan",
		"DTSTART;VALUE=DATE:20990605",
		"DESCRIPTION:Amount: 12.5 USD\\nBilling cycle: Monthly\\nCategory: Developer Tools\\nPayment method: Credit Card\\nNotes: Team\\, shared\\; admin",
		"CATEGORIES:Developer Tools",
		"URL:https://example.com/active",
		"BEGIN:VALARM",
		"TRIGGER:-P5D",
	} {
		if !strings.Contains(unfoldedICS, expected) {
			t.Fatalf("expected ICS to contain %q, got:\n%s", expected, unfoldedICS)
		}
	}
	quietSection := calendarEventSection(t, unfoldedICS, "SUMMARY:Quiet Plan")
	if strings.Contains(quietSection, "BEGIN:VALARM") {
		t.Fatalf("expected disabled reminder event to keep VEVENT but omit alarm, got:\n%s", quietSection)
	}
	for _, excluded := range []string{"Paused Plan", "Cancelled Plan", "Expired Plan", "One Time Plan", "Past Plan", "RRULE"} {
		if strings.Contains(unfoldedICS, excluded) {
			t.Fatalf("expected ICS to exclude %q, got:\n%s", excluded, unfoldedICS)
		}
	}
	for _, rawValue := range []string{"developer_tools", "credit_card"} {
		if strings.Contains(unfoldedICS, rawValue) {
			t.Fatalf("expected ICS to use localized labels instead of %q, got:\n%s", rawValue, unfoldedICS)
		}
	}

	reuseRes := serveTestRequest(t, app, http.MethodPost, "/api/app/calendar-feed", `{}`, token)
	if reuseRes.Code != http.StatusOK {
		t.Fatalf("expected calendar feed reuse 200, got %d: %s", reuseRes.Code, reuseRes.Body.String())
	}
	reuseBody := decodeAPISuccessDataForTest[calendarFeedCreateResponse](t, reuseRes.Body.Bytes())
	if reuseBody.CalendarFeed.FeedURL != createBody.CalendarFeed.FeedURL {
		t.Fatal("expected repeated create to return the existing feed URL")
	}

	deleteRes := serveTestRequest(t, app, http.MethodDelete, "/api/app/calendar-feed", "", token)
	if deleteRes.Code != http.StatusOK {
		t.Fatalf("expected calendar feed delete 200, got %d: %s", deleteRes.Code, deleteRes.Body.String())
	}
	if revokedRes := serveTestRequest(t, app, http.MethodGet, calendarFeedRequestTarget(t, createBody.CalendarFeed.FeedURL), "", ""); revokedRes.Code != http.StatusNotFound {
		t.Fatalf("expected revoked calendar feed URL to return 404, got %d: %s", revokedRes.Code, revokedRes.Body.String())
	}
	regenerateRes := serveTestRequest(t, app, http.MethodPost, "/api/app/calendar-feed", `{}`, token)
	if regenerateRes.Code != http.StatusOK {
		t.Fatalf("expected regenerated calendar feed create 200, got %d: %s", regenerateRes.Code, regenerateRes.Body.String())
	}
	regenerateBody := decodeAPISuccessDataForTest[calendarFeedCreateResponse](t, regenerateRes.Body.Bytes())
	if regenerateBody.CalendarFeed.FeedURL == createBody.CalendarFeed.FeedURL {
		t.Fatal("expected delete then create to issue a new feed URL")
	}
}

func TestSubscriptionCalendarFeedLifecycleAndICSRoute(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "calendar-subscription")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceEnUS)
	settings.Timezone = "UTC"
	settings.NotificationReminderDays = 5
	createCalendarFeedTestSettings(t, app, user, settings)
	createCalendarFeedTestCustomConfig(t, app, user.Id)
	createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:            "Active Plan",
		BillingCycle:    "monthly",
		Status:          "active",
		NextBillingDate: "2099-06-02",
	})
	paused := createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:            "Paused Plan",
		Price:           "9",
		BillingCycle:    "monthly",
		Category:        "developer_tools",
		Status:          "paused",
		PaymentMethod:   "credit_card",
		NextBillingDate: "2099-06-03",
		Notes:           "Paused but user requested calendar subscription",
	})
	oneTime := createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:            "One Time Plan",
		BillingCycle:    "one-time",
		Status:          "active",
		NextBillingDate: "2099-06-04",
	})
	fixedTerm := createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:             "Fixed Term Plan",
		BillingCycle:     "one-time",
		OneTimeTermCount: 6,
		OneTimeTermUnit:  "month",
		Status:           "active",
		NextBillingDate:  "2099-06-05",
	})

	statusRes := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions/"+paused.Id+"/calendar-feed", "", token)
	if statusRes.Code != http.StatusOK || !strings.Contains(statusRes.Body.String(), `"enabled":false`) {
		t.Fatalf("expected disabled subscription calendar feed status, got %d: %s", statusRes.Code, statusRes.Body.String())
	}

	firstRes := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+paused.Id+"/calendar-feed", `{}`, token)
	secondRes := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+paused.Id+"/calendar-feed", `{}`, token)
	if firstRes.Code != http.StatusOK || secondRes.Code != http.StatusOK {
		t.Fatalf("expected subscription calendar feed create 200, got %d/%d: %s %s", firstRes.Code, secondRes.Code, firstRes.Body.String(), secondRes.Body.String())
	}
	firstBody := decodeAPISuccessDataForTest[calendarFeedCreateResponse](t, firstRes.Body.Bytes())
	secondBody := decodeAPISuccessDataForTest[calendarFeedCreateResponse](t, secondRes.Body.Bytes())
	if firstBody.CalendarFeed.FeedURL != secondBody.CalendarFeed.FeedURL {
		t.Fatal("expected repeated subscription feed create to return the existing URL")
	}

	firstICSRes := serveTestRequest(t, app, http.MethodGet, calendarFeedRequestTarget(t, firstBody.CalendarFeed.FeedURL), "", "")
	if firstICSRes.Code != http.StatusOK {
		t.Fatalf("expected subscription feed ICS 200, got %d: %s", firstICSRes.Code, firstICSRes.Body.String())
	}
	assertCalendarFeedLineEndings(t, firstICSRes.Body.String())
	unfoldedICS := unfoldCalendarTestICS(firstICSRes.Body.String())
	for _, expected := range []string{
		"NAME:Renewlet - Paused Plan",
		"SUMMARY:Paused Plan",
		"DESCRIPTION:Amount: 9 USD\\nBilling cycle: Monthly\\nCategory: Developer Tools\\nPayment method: Credit Card\\nNotes: Paused but user requested calendar subscription",
		"CATEGORIES:Developer Tools",
		"DTSTART;VALUE=DATE:20990603",
	} {
		if !strings.Contains(unfoldedICS, expected) {
			t.Fatalf("expected subscription ICS to contain %q, got:\n%s", expected, unfoldedICS)
		}
	}
	if strings.Contains(unfoldedICS, "Active Plan") {
		t.Fatalf("expected subscription ICS to only contain the selected subscription, got:\n%s", unfoldedICS)
	}
	for _, rawValue := range []string{"developer_tools", "credit_card"} {
		if strings.Contains(unfoldedICS, rawValue) {
			t.Fatalf("expected subscription ICS to use localized labels instead of %q, got:\n%s", rawValue, unfoldedICS)
		}
	}

	oneTimeRes := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+oneTime.Id+"/calendar-feed", `{}`, token)
	if oneTimeRes.Code != http.StatusNotFound {
		t.Fatalf("expected one-time buyout subscription feed create 404, got %d: %s", oneTimeRes.Code, oneTimeRes.Body.String())
	}
	oneTimeStatusRes := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions/"+oneTime.Id+"/calendar-feed", "", token)
	if oneTimeStatusRes.Code != http.StatusNotFound {
		t.Fatalf("expected one-time buyout subscription feed status 404, got %d: %s", oneTimeStatusRes.Code, oneTimeStatusRes.Body.String())
	}

	fixedTermRes := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+fixedTerm.Id+"/calendar-feed", `{}`, token)
	if fixedTermRes.Code != http.StatusOK {
		t.Fatalf("expected fixed-term one-time subscription feed create 200, got %d: %s", fixedTermRes.Code, fixedTermRes.Body.String())
	}
	fixedTermBody := decodeAPISuccessDataForTest[calendarFeedCreateResponse](t, fixedTermRes.Body.Bytes())
	fixedTermICS := unfoldCalendarTestICS(serveTestRequest(t, app, http.MethodGet, calendarFeedRequestTarget(t, fixedTermBody.CalendarFeed.FeedURL), "", "").Body.String())
	if !strings.Contains(fixedTermICS, "SUMMARY:Fixed Term Plan") || !strings.Contains(fixedTermICS, "UID:renewlet-expiry-") {
		t.Fatalf("expected explicit fixed-term subscription feed to include expiry item, got:\n%s", fixedTermICS)
	}

	deleteRes := serveTestRequest(t, app, http.MethodDelete, "/api/app/subscriptions/"+paused.Id+"/calendar-feed", "", token)
	if deleteRes.Code != http.StatusOK {
		t.Fatalf("expected subscription calendar feed delete 200, got %d: %s", deleteRes.Code, deleteRes.Body.String())
	}
	if revokedFirst := serveTestRequest(t, app, http.MethodGet, calendarFeedRequestTarget(t, firstBody.CalendarFeed.FeedURL), "", ""); revokedFirst.Code != http.StatusNotFound {
		t.Fatalf("expected first subscription feed URL to return 404, got %d: %s", revokedFirst.Code, revokedFirst.Body.String())
	}
}

func TestSubscriptionCalendarICSDownload(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "calendar-download")
	otherUser, otherToken := createRouteTestUser(t, app, "calendar-download-other")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceEnUS)
	settings.Timezone = "UTC"
	settings.NotificationReminderDays = 5
	createCalendarFeedTestSettings(t, app, user, settings)
	createCalendarFeedTestCustomConfig(t, app, user.Id)
	paused := createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:            "Paused Plan",
		Price:           "9",
		BillingCycle:    "monthly",
		Category:        "developer_tools",
		Status:          "paused",
		PaymentMethod:   "credit_card",
		NextBillingDate: "2099-06-03",
		Notes:           "One-off download",
	})
	buyout := createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:            "One Time Plan",
		BillingCycle:    "one-time",
		Status:          "active",
		NextBillingDate: "2099-06-04",
	})
	fixedTerm := createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:             "Fixed Term Plan",
		BillingCycle:     "one-time",
		OneTimeTermCount: 6,
		OneTimeTermUnit:  "month",
		Status:           "active",
		NextBillingDate:  "2099-06-05",
	})
	otherSubscription := createCalendarFeedTestSubscription(t, app, otherUser.Id, calendarFeedTestSubscription{
		Name:            "Other Plan",
		BillingCycle:    "monthly",
		Status:          "active",
		NextBillingDate: "2099-06-06",
	})

	downloadRes := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions/"+paused.Id+"/calendar.ics", "", token)
	if downloadRes.Code != http.StatusOK {
		t.Fatalf("expected subscription ICS download 200, got %d: %s", downloadRes.Code, downloadRes.Body.String())
	}
	if got := downloadRes.Header().Get("Content-Type"); got != "text/calendar; charset=utf-8" {
		t.Fatalf("expected text/calendar content type, got %q", got)
	}
	if got := downloadRes.Header().Get("Content-Disposition"); got != `attachment; filename="renewlet-`+paused.Id+`.ics"` {
		t.Fatalf("expected attachment filename header, got %q", got)
	}
	if got := downloadRes.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("expected no-store cache header, got %q", got)
	}
	if got := downloadRes.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("expected nosniff header, got %q", got)
	}
	assertCalendarFeedLineEndings(t, downloadRes.Body.String())
	unfoldedICS := unfoldCalendarTestICS(downloadRes.Body.String())
	for _, expected := range []string{
		"NAME:Renewlet - Paused Plan",
		"SUMMARY:Paused Plan",
		"DESCRIPTION:Amount: 9 USD\\nBilling cycle: Monthly\\nCategory: Developer Tools\\nPayment method: Credit Card\\nNotes: One-off download",
		"CATEGORIES:Developer Tools",
		"DTSTART;VALUE=DATE:20990603",
	} {
		if !strings.Contains(unfoldedICS, expected) {
			t.Fatalf("expected downloaded ICS to contain %q, got:\n%s", expected, unfoldedICS)
		}
	}
	for _, excluded := range []string{"SOURCE;VALUE=URI", "REFRESH-INTERVAL", "X-PUBLISHED-TTL", "Other Plan"} {
		if strings.Contains(unfoldedICS, excluded) {
			t.Fatalf("expected one-off download to exclude %q, got:\n%s", excluded, unfoldedICS)
		}
	}

	ownerLeakRes := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions/"+otherSubscription.Id+"/calendar.ics", "", token)
	if ownerLeakRes.Code != http.StatusNotFound {
		t.Fatalf("expected non-owner download to return 404, got %d: %s", ownerLeakRes.Code, ownerLeakRes.Body.String())
	}
	otherTokenRes := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions/"+paused.Id+"/calendar.ics", "", otherToken)
	if otherTokenRes.Code != http.StatusNotFound {
		t.Fatalf("expected other user download to return 404, got %d: %s", otherTokenRes.Code, otherTokenRes.Body.String())
	}

	buyoutRes := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions/"+buyout.Id+"/calendar.ics", "", token)
	if buyoutRes.Code != http.StatusNotFound {
		t.Fatalf("expected one-time buyout download to return 404, got %d: %s", buyoutRes.Code, buyoutRes.Body.String())
	}

	fixedTermRes := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions/"+fixedTerm.Id+"/calendar.ics", "", token)
	if fixedTermRes.Code != http.StatusOK {
		t.Fatalf("expected fixed-term download 200, got %d: %s", fixedTermRes.Code, fixedTermRes.Body.String())
	}
	fixedTermICS := unfoldCalendarTestICS(fixedTermRes.Body.String())
	if !strings.Contains(fixedTermICS, "SUMMARY:Fixed Term Plan") || !strings.Contains(fixedTermICS, "UID:renewlet-expiry-") {
		t.Fatalf("expected fixed-term download to include expiry item, got:\n%s", fixedTermICS)
	}
}

func TestCalendarFeedICSSkipsInvalidDateOnlyEvents(t *testing.T) {
	now, err := time.Parse(time.RFC3339, "2026-05-29T10:20:30Z")
	if err != nil {
		t.Fatal(err)
	}
	body := buildCalendarFeedICS(calendarFeedBuildOptions{
		Name:     "Renewlet - Invalid Date Plan",
		Now:      now,
		Settings: defaultAppSettings(),
		Events: []calendarFeedEvent{{
			UID:         "renewlet-renewal-sub_invalid@renewlet",
			Kind:        "renewal",
			Date:        "not-a-date",
			Summary:     "Invalid Date Plan",
			Description: "Amount: 9 USD",
		}},
		RefreshableSource: false,
	})

	assertCalendarFeedLineEndings(t, body)
	if !strings.Contains(body, "BEGIN:VCALENDAR") || !strings.Contains(body, "END:VCALENDAR") {
		t.Fatalf("expected valid VCALENDAR output, got:\n%s", body)
	}
	if strings.Contains(body, "BEGIN:VEVENT") {
		t.Fatalf("expected invalid date-only event to be skipped, got:\n%s", body)
	}
}

func TestCalendarFeedUsesBuiltInLabelsWhenCustomConfigIsMissing(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "calendar-built-in-labels")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceZhCN)
	settings.Timezone = "UTC"
	createCalendarFeedTestSettings(t, app, user, settings)
	createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:            "Sentry Team",
		Price:           "26",
		BillingCycle:    "monthly",
		Category:        "developer_tools",
		Status:          "active",
		PaymentMethod:   "bank_transfer",
		NextBillingDate: "2099-06-02",
	})

	createRes := serveTestRequest(t, app, http.MethodPost, "/api/app/calendar-feed", `{}`, token)
	if createRes.Code != http.StatusOK {
		t.Fatalf("expected calendar feed create 200, got %d: %s", createRes.Code, createRes.Body.String())
	}
	createBody := decodeAPISuccessDataForTest[calendarFeedCreateResponse](t, createRes.Body.Bytes())

	icsRes := serveTestRequest(t, app, http.MethodGet, calendarFeedRequestTarget(t, createBody.CalendarFeed.FeedURL), "", "")
	if icsRes.Code != http.StatusOK {
		t.Fatalf("expected calendar feed ICS 200, got %d: %s", icsRes.Code, icsRes.Body.String())
	}
	unfoldedICS := unfoldCalendarTestICS(icsRes.Body.String())
	for _, expected := range []string{
		"DESCRIPTION:金额：26 USD\\n周期：每月\\n分类：开发工具\\n支付方式：银行转账",
		"CATEGORIES:开发工具",
	} {
		if !strings.Contains(unfoldedICS, expected) {
			t.Fatalf("expected ICS to contain %q, got:\n%s", expected, unfoldedICS)
		}
	}
	for _, rawValue := range []string{"developer_tools", "bank_transfer"} {
		if strings.Contains(unfoldedICS, rawValue) {
			t.Fatalf("expected ICS to use built-in labels instead of %q, got:\n%s", rawValue, unfoldedICS)
		}
	}
}

func TestCalendarFeedDescribesCustomCycleUnit(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "calendar-custom-cycle")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceZhCN)
	settings.Timezone = "UTC"
	createCalendarFeedTestSettings(t, app, user, settings)
	createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:            "Three Year Plan",
		Price:           "360",
		BillingCycle:    "custom",
		CustomDays:      3,
		CustomCycleUnit: "year",
		Category:        "developer_tools",
		Status:          "active",
		NextBillingDate: "2099-06-02",
	})

	createRes := serveTestRequest(t, app, http.MethodPost, "/api/app/calendar-feed", `{}`, token)
	if createRes.Code != http.StatusOK {
		t.Fatalf("expected calendar feed create 200, got %d: %s", createRes.Code, createRes.Body.String())
	}
	createBody := decodeAPISuccessDataForTest[calendarFeedCreateResponse](t, createRes.Body.Bytes())

	icsRes := serveTestRequest(t, app, http.MethodGet, calendarFeedRequestTarget(t, createBody.CalendarFeed.FeedURL), "", "")
	if icsRes.Code != http.StatusOK {
		t.Fatalf("expected calendar feed ICS 200, got %d: %s", icsRes.Code, icsRes.Body.String())
	}
	unfoldedICS := unfoldCalendarTestICS(icsRes.Body.String())
	if !strings.Contains(unfoldedICS, "周期：每 3 年") {
		t.Fatalf("expected ICS to describe custom cycle unit, got:\n%s", unfoldedICS)
	}
}

func TestCalendarFeedUsesBuiltInLabelsWhenCustomConfigMissesEntry(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "calendar-missing-config-labels")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceZhCN)
	settings.Timezone = "UTC"
	createCalendarFeedTestSettings(t, app, user, settings)
	createCalendarFeedTestCustomConfig(t, app, user.Id, func(config *customConfigPayload) {
		config.Categories = []customConfigItem{}
		config.PaymentMethods = []customConfigItem{}
	})
	createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:            "Missing Config Plan",
		Price:           "26",
		BillingCycle:    "monthly",
		Category:        "developer_tools",
		Status:          "active",
		PaymentMethod:   "bank_transfer",
		NextBillingDate: "2099-06-02",
	})

	createRes := serveTestRequest(t, app, http.MethodPost, "/api/app/calendar-feed", `{}`, token)
	if createRes.Code != http.StatusOK {
		t.Fatalf("expected calendar feed create 200, got %d: %s", createRes.Code, createRes.Body.String())
	}
	createBody := decodeAPISuccessDataForTest[calendarFeedCreateResponse](t, createRes.Body.Bytes())

	icsRes := serveTestRequest(t, app, http.MethodGet, calendarFeedRequestTarget(t, createBody.CalendarFeed.FeedURL), "", "")
	if icsRes.Code != http.StatusOK {
		t.Fatalf("expected calendar feed ICS 200, got %d: %s", icsRes.Code, icsRes.Body.String())
	}
	unfoldedICS := unfoldCalendarTestICS(icsRes.Body.String())
	for _, expected := range []string{
		"分类：开发工具",
		"支付方式：银行转账",
		"CATEGORIES:开发工具",
	} {
		if !strings.Contains(unfoldedICS, expected) {
			t.Fatalf("expected ICS to contain %q, got:\n%s", expected, unfoldedICS)
		}
	}
	for _, rawValue := range []string{"developer_tools", "bank_transfer"} {
		if strings.Contains(unfoldedICS, rawValue) {
			t.Fatalf("expected ICS to use built-in labels instead of %q, got:\n%s", rawValue, unfoldedICS)
		}
	}
}

func TestCalendarFeedPreservesUnknownConfigValues(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "calendar-unknown-labels")
	settings := defaultAppSettings()
	settings.LocalePreference = string(preferenceEnUS)
	settings.Timezone = "UTC"
	createCalendarFeedTestSettings(t, app, user, settings)
	createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name:            "Unknown Plan",
		Price:           "7",
		BillingCycle:    "monthly",
		Category:        "internal_ops",
		Status:          "active",
		PaymentMethod:   "wire_custom",
		NextBillingDate: "2099-06-02",
	})

	createRes := serveTestRequest(t, app, http.MethodPost, "/api/app/calendar-feed", `{}`, token)
	if createRes.Code != http.StatusOK {
		t.Fatalf("expected calendar feed create 200, got %d: %s", createRes.Code, createRes.Body.String())
	}
	createBody := decodeAPISuccessDataForTest[calendarFeedCreateResponse](t, createRes.Body.Bytes())

	icsRes := serveTestRequest(t, app, http.MethodGet, calendarFeedRequestTarget(t, createBody.CalendarFeed.FeedURL), "", "")
	if icsRes.Code != http.StatusOK {
		t.Fatalf("expected calendar feed ICS 200, got %d: %s", icsRes.Code, icsRes.Body.String())
	}
	unfoldedICS := unfoldCalendarTestICS(icsRes.Body.String())
	for _, expected := range []string{
		"Category: internal_ops",
		"Payment method: wire_custom",
		"CATEGORIES:internal_ops",
	} {
		if !strings.Contains(unfoldedICS, expected) {
			t.Fatalf("expected ICS to contain %q, got:\n%s", expected, unfoldedICS)
		}
	}
}

func TestCalendarFeedLabelResolverIgnoresEmptyCustomLabels(t *testing.T) {
	resolver := calendarFeedLabelResolver{
		locale: localeZhCN,
		categoryByValue: calendarFeedLabelMap([]customConfigItem{{
			Value:  "developer_tools",
			Labels: customConfigLabels{},
		}}, localeZhCN),
		paymentMethodByValue: calendarFeedLabelMap([]customConfigItem{{
			Value:  "bank_transfer",
			Labels: customConfigLabels{},
		}}, localeZhCN),
	}
	if got := resolver.categoryLabel("developer_tools"); got != "开发工具" {
		t.Fatalf("expected built-in category label, got %q", got)
	}
	if got := resolver.paymentMethodLabel("bank_transfer"); got != "银行转账" {
		t.Fatalf("expected built-in payment method label, got %q", got)
	}
}

type calendarFeedTestSubscription struct {
	Name             string
	Price            string
	Currency         string
	BillingCycle     string
	CustomDays       int
	CustomCycleUnit  string
	Category         string
	Status           string
	PaymentMethod    string
	NextBillingDate  string
	Website          string
	Notes            string
	ReminderDays     int
	OneTimeTermCount int
	OneTimeTermUnit  string
}

func createCalendarFeedTestSettings(t *testing.T, app core.App, user *core.Record, settings appSettings) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("settings")
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(collection)
	record.Set("user", user.Id)
	record.Set("settings", settings)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
	return record
}

func createCalendarFeedTestCustomConfig(t *testing.T, app core.App, userID string, configure ...func(*customConfigPayload)) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("custom_configs")
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(collection)
	record.Set("user", userID)
	config := customConfigPayload{
		Categories: []customConfigItem{{
			ID:    "developer_tools",
			Value: "developer_tools",
			Labels: customConfigLabels{
				ZhCN: "开发工具",
				EnUS: "Developer Tools",
			},
			Color: "hsl(265 68% 58%)",
		}},
		PaymentMethods: []customConfigItem{{
			ID:    "credit_card",
			Value: "credit_card",
			Labels: customConfigLabels{
				ZhCN: "信用卡",
				EnUS: "Credit Card",
			},
		}},
	}
	for _, apply := range configure {
		apply(&config)
	}
	record.Set("config", config)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
	return record
}

func createCalendarFeedTestSubscription(t *testing.T, app core.App, userID string, input calendarFeedTestSubscription) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("subscriptions")
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(collection)
	record.Set("user", userID)
	record.Set("name", fallbackString(input.Name, "Calendar Plan"))
	record.Set("price", fallbackString(input.Price, "12"))
	record.Set("currency", fallbackString(input.Currency, "USD"))
	record.Set("billingCycle", fallbackString(input.BillingCycle, "monthly"))
	record.Set("customDays", input.CustomDays)
	record.Set("customCycleUnit", input.CustomCycleUnit)
	record.Set("oneTimeTermCount", input.OneTimeTermCount)
	record.Set("oneTimeTermUnit", input.OneTimeTermUnit)
	record.Set("category", fallbackString(input.Category, "General"))
	record.Set("status", fallbackString(input.Status, "active"))
	record.Set("paymentMethod", input.PaymentMethod)
	nextBillingDate := fallbackString(input.NextBillingDate, "2099-06-01")
	startDate := "2099-01-01"
	if nextBillingDate < startDate {
		startDate = nextBillingDate
	}
	record.Set("startDate", startDate)
	record.Set("nextBillingDate", nextBillingDate)
	record.Set("autoCalculateNextBillingDate", true)
	record.Set("website", input.Website)
	record.Set("notes", input.Notes)
	record.Set("tags", []string{})
	record.Set("extra", emptyJSONPayload{})
	record.Set("reminderDays", input.ReminderDays)
	record.Set("repeatReminderEnabled", false)
	record.Set("repeatReminderInterval", defaultRepeatReminderInterval)
	record.Set("repeatReminderWindow", defaultRepeatReminderWindow)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
	return record
}

func calendarFeedTokenFromURL(t *testing.T, rawURL string) string {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	token := parsed.Query().Get("token")
	if token == "" {
		t.Fatalf("feed URL missing token: %s", rawURL)
	}
	return token
}

func calendarFeedRequestTarget(t *testing.T, rawURL string) string {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	return parsed.RequestURI()
}

func unfoldCalendarTestICS(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "\r\n ", ""), "\n ", "")
}

func calendarEventSection(t *testing.T, ics string, marker string) string {
	t.Helper()
	index := strings.Index(ics, marker)
	if index < 0 {
		t.Fatalf("expected ICS to contain marker %q, got:\n%s", marker, ics)
	}
	start := strings.LastIndex(ics[:index], "BEGIN:VEVENT")
	end := strings.Index(ics[index:], "END:VEVENT")
	if start < 0 || end < 0 {
		t.Fatalf("expected marker %q to be inside VEVENT, got:\n%s", marker, ics)
	}
	return ics[start : index+end+len("END:VEVENT")]
}

func assertCalendarFeedLineEndings(t *testing.T, value string) {
	t.Helper()
	if !strings.Contains(value, "\r\n") {
		t.Fatalf("expected ICS to use CRLF line endings, got:\n%s", value)
	}
	for index, char := range []byte(value) {
		if char == '\n' && (index == 0 || value[index-1] != '\r') {
			t.Fatalf("expected ICS to avoid bare LF at byte %d, got:\n%s", index, value)
		}
	}
}

func fallbackString(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
