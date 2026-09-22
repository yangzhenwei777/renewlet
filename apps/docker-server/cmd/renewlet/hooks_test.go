package main

// Hook 测试保护 PocketBase API、SDK 和管理后台写入共享同一套持久层校验。
// 这些用例不是 UI 行为测试，而是防止绕过自定义 route 时写入坏 date-only、Logo 或 JSON 形状。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

type memoryUploadReader struct {
	data []byte
}

func (r memoryUploadReader) Open() (io.ReadSeekCloser, error) {
	return readSeekCloser{Reader: bytes.NewReader(r.data)}, nil
}

type readSeekCloser struct {
	*bytes.Reader
}

func (readSeekCloser) Close() error {
	return nil
}

func TestDetectUploadMimeTypeRecognizesSvgDocuments(t *testing.T) {
	cases := []string{
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`,
		`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`,
	}

	for _, content := range cases {
		got, err := detectUploadMimeType(memoryUploadReader{data: []byte(content)})
		if err != nil {
			t.Fatal(err)
		}
		if got != "image/svg+xml" {
			t.Fatalf("detectUploadMimeType() = %q, want image/svg+xml", got)
		}
		if !isAllowedImageMime(got) {
			t.Fatalf("expected %q to be allowed", got)
		}
	}
}

func TestDetectUploadMimeTypeRecognizesIcoDocuments(t *testing.T) {
	got, err := detectUploadMimeType(memoryUploadReader{data: []byte("\x00\x00\x01\x00\x01\x00\x10\x10\x00\x00")})
	if err != nil {
		t.Fatal(err)
	}
	if got != "image/x-icon" {
		t.Fatalf("detectUploadMimeType() = %q, want image/x-icon", got)
	}
	if !isAllowedImageMime(got) {
		t.Fatalf("expected %q to be allowed", got)
	}
}

func TestDetectUploadMimeTypeRejectsNonSvgXml(t *testing.T) {
	got, err := detectUploadMimeType(memoryUploadReader{data: []byte(`<?xml version="1.0"?><html></html>`)})
	if err != nil {
		t.Fatal(err)
	}
	if got == "image/svg+xml" || isAllowedImageMime(got) {
		t.Fatalf("expected non-SVG XML to be rejected, got %q", got)
	}
}

func TestSubscriptionSchedulerStateRefreshesAfterSubscriptionWrites(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, _ := createRouteTestUser(t, app, "scheduler-state")

	record := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"autoRenew":             false,
		"repeatReminderEnabled": false,
	})
	state, err := getSubscriptionSchedulerState(app, user.Id)
	if err != nil {
		t.Fatal(err)
	}
	if state.AutoRenewCount != 0 || state.RepeatReminderCount != 0 {
		t.Fatalf("initial scheduler state = %#v, want zero counts", state)
	}

	record.Set("autoRenew", true)
	record.Set("repeatReminderEnabled", true)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
	state, err = getSubscriptionSchedulerState(app, user.Id)
	if err != nil {
		t.Fatal(err)
	}
	if state.AutoRenewCount != 1 || state.RepeatReminderCount != 1 {
		t.Fatalf("updated scheduler state = %#v, want one auto and one repeat", state)
	}

	if err := markSubscriptionAutoRenewChecked(app, user.Id, "2026-05-14"); err != nil {
		t.Fatal(err)
	}
	record.Set("notes", "invalidate scheduler check")
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
	state, err = getSubscriptionSchedulerState(app, user.Id)
	if err != nil {
		t.Fatal(err)
	}
	if state.LastAutoRenewLocalDate != "" {
		t.Fatalf("expected subscription update to invalidate last auto renew check, got %#v", state)
	}

	if err := app.Delete(record); err != nil {
		t.Fatal(err)
	}
	state, err = getSubscriptionSchedulerState(app, user.Id)
	if err != nil {
		t.Fatal(err)
	}
	if state.AutoRenewCount != 0 || state.RepeatReminderCount != 0 {
		t.Fatalf("deleted scheduler state = %#v, want zero counts", state)
	}
}

func TestNormalizeCustomConfigRecordAllowsMissingGroupsAndRejectsWrongTypes(t *testing.T) {
	collection := core.NewBaseCollection("custom_configs")
	record := core.NewRecord(collection)
	record.Set("config", customConfigPayload{
		Categories: []customConfigItem{{
			ID:    "productivity",
			Value: "productivity",
			Labels: customConfigLabels{
				ZhCN: "生产力",
				EnUS: "Productivity",
			},
		}},
	})

	if err := normalizeCustomConfigRecord(record); err != nil {
		t.Fatal(err)
	}
	var config customConfigPayload
	configData, err := jsonBytesFromValue(record.Get("config"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(configData, &config); err != nil {
		t.Fatal(err)
	}
	if config.Statuses == nil {
		t.Fatalf("expected missing statuses to be backfilled as array: %#v", config.Statuses)
	}

	record.Set("config", types.JSONRaw(`{"categories":"bad"}`))
	if err := normalizeCustomConfigRecord(record); err == nil {
		t.Fatal("expected wrong custom config group type to fail")
	}
}

func TestNormalizeSubscriptionRecordDefaultsAndValidatesContract(t *testing.T) {
	collection := core.NewBaseCollection("subscriptions")
	record := core.NewRecord(collection)
	record.Set("name", " Netflix ")
	record.Set("price", "10")
	record.Set("currency", "usd")
	record.Set("billingCycle", "monthly")
	record.Set("customDays", 30)
	record.Set("customCycleUnit", "year")
	record.Set("startDate", "2026-05-14")
	record.Set("nextBillingDate", "2026-06-14")
	record.Set("tags", []string{"streaming", "streaming", " media "})
	record.Set("reminderDays", 3)

	if err := normalizeSubscriptionRecord(record); err != nil {
		t.Fatal(err)
	}
	if record.GetString("name") != "Netflix" || record.GetString("currency") != "USD" || record.GetInt("customDays") != 0 || record.GetString("customCycleUnit") != "" {
		t.Fatalf("subscription was not normalized: name=%q currency=%q customDays=%d customCycleUnit=%q", record.GetString("name"), record.GetString("currency"), record.GetInt("customDays"), record.GetString("customCycleUnit"))
	}
	tags := record.GetStringSlice("tags")
	if len(tags) != 2 || tags[0] != "streaming" || tags[1] != "media" {
		t.Fatalf("unexpected tags %#v", tags)
	}
	if record.GetString("repeatReminderInterval") != defaultRepeatReminderInterval || record.GetString("repeatReminderWindow") != defaultRepeatReminderWindow {
		t.Fatalf("expected repeat reminder defaults, got interval=%q window=%q", record.GetString("repeatReminderInterval"), record.GetString("repeatReminderWindow"))
	}

	record.Set("repeatReminderInterval", "2h")
	if err := normalizeSubscriptionRecord(record); err == nil {
		t.Fatal("expected invalid repeat reminder interval to fail")
	}
	record.Set("repeatReminderInterval", "1h")
	record.Set("repeatReminderWindow", "forever")
	if err := normalizeSubscriptionRecord(record); err == nil {
		t.Fatal("expected invalid repeat reminder window to fail")
	}
	record.Set("repeatReminderWindow", "72h")

	record.Set("billingCycle", "custom")
	record.Set("customDays", 0)
	if err := normalizeSubscriptionRecord(record); err == nil {
		t.Fatal("expected custom billing cycle without customDays to fail")
	}
	record.Set("customDays", 45)
	record.Set("customCycleUnit", "")
	if err := normalizeSubscriptionRecord(record); err == nil {
		t.Fatal("expected custom billing cycle without a unit to fail")
	}
	record.Set("customCycleUnit", "decade")
	if err := normalizeSubscriptionRecord(record); err == nil {
		t.Fatal("expected invalid custom cycle unit to fail")
	}

	record.Set("billingCycle", "one-time")
	record.Set("customDays", 45)
	record.Set("customCycleUnit", "week")
	record.Set("oneTimeTermCount", 0)
	record.Set("oneTimeTermUnit", "")
	record.Set("autoRenew", true)
	record.Set("autoCalculateNextBillingDate", true)
	if err := normalizeSubscriptionRecord(record); err != nil {
		t.Fatalf("expected one-time billing cycle to be accepted: %v", err)
	}
	if record.GetInt("customDays") != 0 || record.GetString("customCycleUnit") != "" || record.GetInt("oneTimeTermCount") != 0 || record.GetString("oneTimeTermUnit") != "" || record.GetBool("autoRenew") || record.GetBool("autoCalculateNextBillingDate") {
		t.Fatalf("expected one-time buyout to clear custom fields and renewal flags, got customDays=%d customCycleUnit=%q oneTimeTermCount=%d oneTimeTermUnit=%q autoRenew=%v auto=%v", record.GetInt("customDays"), record.GetString("customCycleUnit"), record.GetInt("oneTimeTermCount"), record.GetString("oneTimeTermUnit"), record.GetBool("autoRenew"), record.GetBool("autoCalculateNextBillingDate"))
	}

	record.Set("billingCycle", "one-time")
	record.Set("oneTimeTermCount", 6)
	record.Set("oneTimeTermUnit", "month")
	record.Set("autoRenew", true)
	record.Set("autoCalculateNextBillingDate", true)
	if err := normalizeSubscriptionRecord(record); err != nil {
		t.Fatalf("expected one-time fixed term to be accepted: %v", err)
	}
	if record.GetInt("oneTimeTermCount") != 6 || record.GetString("oneTimeTermUnit") != "month" || record.GetBool("autoRenew") || record.GetBool("autoCalculateNextBillingDate") {
		t.Fatalf("expected one-time fixed term to preserve term and disable renewal flags, got count=%d unit=%q autoRenew=%v auto=%v", record.GetInt("oneTimeTermCount"), record.GetString("oneTimeTermUnit"), record.GetBool("autoRenew"), record.GetBool("autoCalculateNextBillingDate"))
	}

	record.Set("oneTimeTermUnit", "")
	if err := normalizeSubscriptionRecord(record); err == nil {
		t.Fatal("expected one-time term count without unit to fail")
	}
	record.Set("oneTimeTermCount", 0)
	record.Set("oneTimeTermUnit", "month")
	if err := normalizeSubscriptionRecord(record); err == nil {
		t.Fatal("expected one-time term unit without count to fail")
	}
	record.Set("oneTimeTermCount", maxReminderDays+1)
	record.Set("oneTimeTermUnit", "month")
	if err := normalizeSubscriptionRecord(record); err == nil {
		t.Fatal("expected one-time term count above max to fail")
	}
	record.Set("oneTimeTermCount", 6)
	record.Set("oneTimeTermUnit", "month")
	record.Set("billingCycle", "monthly")
	if err := normalizeSubscriptionRecord(record); err != nil {
		t.Fatalf("expected recurring subscription to clear stale one-time term fields: %v", err)
	}
	if record.GetInt("oneTimeTermCount") != 0 || record.GetString("oneTimeTermUnit") != "" {
		t.Fatalf("expected recurring subscription to clear one-time term fields, got count=%d unit=%q", record.GetInt("oneTimeTermCount"), record.GetString("oneTimeTermUnit"))
	}
	record.Set("oneTimeTermCount", -1)
	record.Set("oneTimeTermUnit", "month")
	if err := normalizeSubscriptionRecord(record); err != nil {
		t.Fatalf("expected recurring subscription to clear invalid stale one-time term fields: %v", err)
	}
	if record.GetInt("oneTimeTermCount") != 0 || record.GetString("oneTimeTermUnit") != "" {
		t.Fatalf("expected recurring subscription to clear invalid one-time term fields, got count=%d unit=%q", record.GetInt("oneTimeTermCount"), record.GetString("oneTimeTermUnit"))
	}

	record.Set("billingCycle", "monthly")
	record.Set("price", "0")
	if err := normalizeSubscriptionRecord(record); err != nil {
		t.Fatalf("expected zero price to be accepted: %v", err)
	}

	record.Set("price", 0.1)
	if err := normalizeSubscriptionRecord(record); err == nil {
		t.Fatal("expected numeric price write to fail after decimal string migration")
	}

	record.Set("price", "-1")
	if err := normalizeSubscriptionRecord(record); err == nil {
		t.Fatal("expected negative price to fail")
	}

	record.Set("price", fmt.Sprintf("%d.000001", maxSubscriptionPrice))
	if err := normalizeSubscriptionRecord(record); err == nil {
		t.Fatal("expected too-high price to fail")
	}

	record.Set("price", "10")
	record.Set("reminderDays", disabledReminderDays)
	if err := normalizeSubscriptionRecord(record); err != nil {
		t.Fatalf("expected disabled reminder days to be accepted: %v", err)
	}
	record.Set("reminderDays", inheritReminderDays)
	if err := normalizeSubscriptionRecord(record); err != nil {
		t.Fatalf("expected inherited reminder days to be accepted: %v", err)
	}
	record.Set("reminderDays", disabledReminderDays-1)
	if err := normalizeSubscriptionRecord(record); err == nil {
		t.Fatal("expected reminder days below disabled sentinel to fail")
	}
	record.Set("reminderDays", maxReminderDays+1)
	if err := normalizeSubscriptionRecord(record); err == nil {
		t.Fatal("expected too-high reminder days to fail")
	}
}

func TestNormalizeSubscriptionRecordValidatesCostSharing(t *testing.T) {
	collection := core.NewBaseCollection("subscriptions")
	base := func(price string, costSharing string) *core.Record {
		record := core.NewRecord(collection)
		record.Set("name", "Family Plan")
		record.Set("price", price)
		record.Set("currency", "USD")
		record.Set("billingCycle", "monthly")
		record.Set("customDays", 0)
		record.Set("startDate", "2026-05-14")
		record.Set("nextBillingDate", "2026-06-14")
		record.Set("tags", []string{})
		record.Set("reminderDays", 3)
		record.Set("costSharing", types.JSONRaw(costSharing))
		return record
	}

	valid := base("100", `{
		"enabled": true,
		"splitMode": "custom",
		"members": [
			{"id": "partner", "name": "Partner", "currency": "USD", "customAmount": "40"},
			{"id": "child", "name": "Child", "currency": "USD", "customAmount": "60"}
		]
	}`)
	if err := normalizeSubscriptionRecord(valid); err != nil {
		t.Fatalf("expected valid cost sharing to be accepted: %v", err)
	}
	data, err := jsonBytesFromValue(valid.Get("costSharing"))
	if err != nil {
		t.Fatal(err)
	}
	var payload costSharingPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.SplitMode != "custom" || len(payload.Members) != 2 || payload.Members[0].CustomAmount == nil || *payload.Members[0].CustomAmount != "40" {
		t.Fatalf("unexpected normalized cost sharing payload: %#v", payload)
	}
	if valid.GetBool("costSharingCollectionReminderEnabled") || valid.GetString("costSharingNextCollectionReminderDate") != "" {
		t.Fatalf("expected disabled collection reminder mirror, enabled=%v next=%q", valid.GetBool("costSharingCollectionReminderEnabled"), valid.GetString("costSharingNextCollectionReminderDate"))
	}

	withCollectionReminder := base("100", `{
		"enabled": true,
		"splitMode": "equal",
		"collectionReminder": {"enabled": true, "reminderDays": -1},
		"members": [
			{"id": "partner", "name": "Partner", "currency": "USD"}
		]
	}`)
	if err := normalizeSubscriptionRecord(withCollectionReminder); err != nil {
		t.Fatalf("expected collection reminder to be accepted: %v", err)
	}
	if !withCollectionReminder.GetBool("costSharingCollectionReminderEnabled") || withCollectionReminder.GetString("costSharingNextCollectionReminderDate") == "" {
		t.Fatalf("expected collection reminder mirror, enabled=%v next=%q", withCollectionReminder.GetBool("costSharingCollectionReminderEnabled"), withCollectionReminder.GetString("costSharingNextCollectionReminderDate"))
	}

	oneTimeBuyoutCollectionReminder := base("100", `{
		"enabled": true,
		"splitMode": "equal",
		"collectionReminder": {"enabled": true, "reminderDays": -1},
		"members": [
			{"id": "partner", "name": "Partner", "currency": "USD"}
		]
	}`)
	oneTimeBuyoutCollectionReminder.Set("billingCycle", "one-time")
	oneTimeBuyoutCollectionReminder.Set("oneTimeTermCount", 0)
	if err := normalizeSubscriptionRecord(oneTimeBuyoutCollectionReminder); err == nil || !strings.Contains(err.Error(), "COST_SHARING_COLLECTION_REMINDER_ONE_TIME_BUYOUT_INVALID") {
		t.Fatalf("expected one-time buyout collection reminder to fail, got %v", err)
	}
	oneTimeTermCollectionReminder := base("100", `{
		"enabled": true,
		"splitMode": "equal",
		"collectionReminder": {"enabled": true, "reminderDays": -1},
		"members": [
			{"id": "partner", "name": "Partner", "currency": "USD"}
		]
	}`)
	oneTimeTermCollectionReminder.Set("billingCycle", "one-time")
	oneTimeTermCollectionReminder.Set("oneTimeTermCount", 6)
	oneTimeTermCollectionReminder.Set("oneTimeTermUnit", "month")
	if err := normalizeSubscriptionRecord(oneTimeTermCollectionReminder); err != nil {
		t.Fatalf("expected fixed-term one-time collection reminder to be accepted: %v", err)
	}

	flexibleTotal := base("100", `{
		"enabled": true,
		"splitMode": "custom",
		"members": [
			{"id": "partner", "name": "Partner", "currency": "USD", "customAmount": "40"},
			{"id": "child", "name": "Child", "currency": "USD", "customAmount": "50"}
		]
	}`)
	if err := normalizeSubscriptionRecord(flexibleTotal); err != nil {
		t.Fatalf("expected flexible custom total to be accepted: %v", err)
	}

	legacyIdentityFields := base("100", `{
		"enabled": true,
		"payerMemberId": "me",
		"selfMemberId": "me",
		"splitMode": "custom",
		"members": [
			{"id": "partner", "name": "Partner", "currency": "USD", "included": true, "customAmount": "40"}
		]
	}`)
	if err := normalizeSubscriptionRecord(legacyIdentityFields); err == nil || !strings.Contains(err.Error(), "COST_SHARING_JSON_INVALID") {
		t.Fatalf("expected legacy cost sharing identity fields to fail, got %v", err)
	}

	invalidCollectionDays := base("100", `{
		"enabled": true,
		"splitMode": "equal",
		"collectionReminder": {"enabled": true, "reminderDays": -2},
		"members": [
			{"id": "partner", "name": "Partner", "currency": "USD"}
		]
	}`)
	if err := normalizeSubscriptionRecord(invalidCollectionDays); err == nil || !strings.Contains(err.Error(), "COST_SHARING_COLLECTION_REMINDER_DAYS_INVALID") {
		t.Fatalf("expected invalid collection reminder days to fail, got %v", err)
	}

	invalidJoinedDateRange := base("100", `{
		"enabled": true,
		"splitMode": "equal",
		"collectionReminder": {"enabled": true, "reminderDays": -1},
		"members": [
			{"id": "partner", "name": "Partner", "joinedDate": "2026-06-15", "currency": "USD"}
		]
	}`)
	if err := normalizeSubscriptionRecord(invalidJoinedDateRange); err == nil || !strings.Contains(err.Error(), "COST_SHARING_MEMBER_JOINED_DATE_OUT_OF_RANGE") {
		t.Fatalf("expected joined date outside subscription range to fail, got %v", err)
	}

	disabledWithCollectionReminder := base("100", `{
		"enabled": false,
		"splitMode": "equal",
		"collectionReminder": {"enabled": true, "reminderDays": -1},
		"members": [
			{"id": "partner", "name": "Partner", "currency": "USD"}
		]
	}`)
	if err := normalizeSubscriptionRecord(disabledWithCollectionReminder); err == nil || !strings.Contains(err.Error(), "COST_SHARING_COLLECTION_REMINDER_INVALID") {
		t.Fatalf("expected disabled cost sharing collection reminder to fail, got %v", err)
	}
}

func TestNormalizeSubscriptionRecordValidatesDateOrder(t *testing.T) {
	collection := core.NewBaseCollection("subscriptions")
	base := func(startDate, nextBillingDate string) *core.Record {
		record := core.NewRecord(collection)
		record.Set("name", "Date Order")
		record.Set("price", "10")
		record.Set("currency", "USD")
		record.Set("billingCycle", "monthly")
		record.Set("customDays", 0)
		record.Set("startDate", startDate)
		record.Set("nextBillingDate", nextBillingDate)
		record.Set("tags", []string{})
		record.Set("reminderDays", 3)
		return record
	}

	if err := normalizeSubscriptionRecord(base("2026-05-14", "2026-05-13")); err == nil || !strings.Contains(err.Error(), "NEXT_BILLING_DATE_BEFORE_START_DATE") {
		t.Fatalf("expected renewal date before start date to fail, got %v", err)
	}
	if err := normalizeSubscriptionRecord(base("2026-05-14", "2026-05-14")); err != nil {
		t.Fatalf("expected same-day renewal date to be accepted: %v", err)
	}
	if err := normalizeSubscriptionRecord(base("", "2026-05-14")); err != nil {
		t.Fatalf("expected manual recurring subscription without start date to be accepted: %v", err)
	}
	autoCalculated := base("", "2026-05-14")
	autoCalculated.Set("autoCalculateNextBillingDate", true)
	if err := normalizeSubscriptionRecord(autoCalculated); err == nil || !strings.Contains(err.Error(), "START_DATE_REQUIRED") {
		t.Fatalf("expected auto calculated subscription without start date to fail, got %v", err)
	}
	oneTime := base("", "2026-05-14")
	oneTime.Set("billingCycle", "one-time")
	if err := normalizeSubscriptionRecord(oneTime); err == nil || !strings.Contains(err.Error(), "START_DATE_REQUIRED") {
		t.Fatalf("expected one-time subscription without start date to fail, got %v", err)
	}
}

func TestNormalizeSubscriptionRecordValidatesLogoReferences(t *testing.T) {
	collection := core.NewBaseCollection("subscriptions")
	base := func(logo string) *core.Record {
		record := core.NewRecord(collection)
		record.Set("name", "Logo Test")
		record.Set("price", "10")
		record.Set("currency", "USD")
		record.Set("billingCycle", "monthly")
		record.Set("customDays", 0)
		record.Set("startDate", "2026-05-14")
		record.Set("nextBillingDate", "2026-06-14")
		record.Set("tags", []string{})
		record.Set("reminderDays", 3)
		record.Set("logo", logo)
		return record
	}

	for _, logo := range []string{
		"",
		"https://example.com/logo.png",
		"http://example.com/logo.png",
		"/api/app/assets/2pbs0lgyypqhjoy",
	} {
		t.Run("allows "+logo, func(t *testing.T) {
			if err := normalizeSubscriptionRecord(base(logo)); err != nil {
				t.Fatalf("expected logo %q to be accepted: %v", logo, err)
			}
		})
	}

	for _, logo := range []string{
		"/api/app/assets/",
		"/other/assets/2pbs0lgyypqhjoy",
		"data:image/png;base64,aGVsbG8=",
		"ftp://example.com/logo.png",
		"https://user:pass@example.com/logo.png",
		"not a url",
	} {
		t.Run("rejects "+logo, func(t *testing.T) {
			if err := normalizeSubscriptionRecord(base(logo)); err == nil {
				t.Fatalf("expected logo %q to be rejected", logo)
			}
		})
	}
}

func TestNormalizeTagsAcceptsPocketBaseJSONShapes(t *testing.T) {
	cases := []struct {
		name  string
		value interface{}
		want  []string
	}{
		{name: "nil", value: nil, want: []string{}},
		{name: "empty slice", value: []string{}, want: []string{}},
		{name: "string slice", value: []string{" work ", "work", ""}, want: []string{"work"}},
		{name: "json raw empty array", value: types.JSONRaw(`[]`), want: []string{}},
		{name: "json raw string array", value: types.JSONRaw(`[" work ","work"," personal "]`), want: []string{"work", "personal"}},
		{name: "json raw null", value: types.JSONRaw(`null`), want: []string{}},
		{name: "raw message", value: json.RawMessage(`["a"]`), want: []string{"a"}},
		{name: "bytes", value: []byte(`["a","b"]`), want: []string{"a", "b"}},
		{name: "json string", value: `["a"]`, want: []string{"a"}},
		{name: "empty string", value: "", want: []string{}},
		{name: "pocketbase json string array", value: types.JSONArray[string]{"a", "b"}, want: []string{"a", "b"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeTags(tc.value)
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("got %#v, want %#v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("got %#v, want %#v", got, tc.want)
				}
			}
		})
	}
}

func TestNormalizeTagsAcceptsProtectiveHighLimit(t *testing.T) {
	tags := make([]string, maxSubscriptionTags)
	for i := range tags {
		tags[i] = fmt.Sprintf("tag-%d", i)
	}

	got, err := normalizeTags(tags)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != maxSubscriptionTags {
		t.Fatalf("got %d tags, want %d", len(got), maxSubscriptionTags)
	}
}

func TestNormalizeTagsRejectsInvalidValues(t *testing.T) {
	tooMany := make([]string, maxSubscriptionTags+1)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("tag-%d", i)
	}
	cases := []struct {
		name  string
		value interface{}
	}{
		{name: "object", value: map[string]bool{"bad": true}},
		{name: "json object", value: types.JSONRaw(`{"bad":true}`)},
		{name: "scalar", value: 1},
		{name: "json scalar", value: types.JSONRaw(`1`)},
		{name: "mixed json array", value: types.JSONRaw(`["ok",1]`)},
		{name: "mixed slice", value: []interface{}{"ok", 1}},
		{name: "too many", value: tooMany},
		{name: "too long", value: []string{strings.Repeat("a", 41)}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := normalizeTags(tc.value); err == nil {
				t.Fatal("expected invalid tags to fail")
			}
		})
	}
}

func TestSubscriptionRecordSaveAcceptsJSONFieldTags(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, err := createUser(app, "Admin", "admin@example.com", "password123", "admin")
	if err != nil {
		t.Fatal(err)
	}

	emptyTags := saveSubscriptionRecord(t, app, user.Id, []string{}, "Aws")
	assertSavedTags(t, emptyTags, []string{})

	tagged := saveSubscriptionRecord(t, app, user.Id, []string{" work ", "work", " cloud "}, "Cloud")
	assertSavedTags(t, tagged, []string{"work", "cloud"})

	tagged.Set("tags", []string{})
	if err := app.Save(tagged); err != nil {
		t.Fatalf("expected clearing tags to succeed: %v", err)
	}
	assertSavedTags(t, tagged, []string{})

	invalid := newSubscriptionRecord(t, app, user.Id, []interface{}{"ok", 1}, "Bad")
	if err := app.Save(invalid); err == nil {
		t.Fatal("expected mixed tag array to fail")
	}
}

func saveSubscriptionRecord(t *testing.T, app core.App, userID string, tags interface{}, name string) *core.Record {
	t.Helper()
	record := newSubscriptionRecord(t, app, userID, tags, name)
	if err := app.Save(record); err != nil {
		t.Fatalf("expected subscription save to succeed: %v", err)
	}
	return record
}

func newSubscriptionRecord(t *testing.T, app core.App, userID string, tags interface{}, name string) *core.Record {
	t.Helper()
	collection, err := app.FindCollectionByNameOrId("subscriptions")
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(collection)
	record.Load(map[string]interface{}{
		"user":                         userID,
		"name":                         name,
		"logo":                         "https://aws.amazon.com/favicon.ico",
		"price":                        "15",
		"currency":                     "USD",
		"billingCycle":                 "monthly",
		"customDays":                   0,
		"category":                     "productivity",
		"status":                       "active",
		"paymentMethod":                "",
		"startDate":                    "2026-05-14",
		"nextBillingDate":              "2026-06-14",
		"autoRenew":                    true,
		"autoCalculateNextBillingDate": true,
		"trialEndDate":                 "",
		"website":                      "",
		"notes":                        "",
		"tags":                         tags,
		"reminderDays":                 3,
	})
	return record
}

func assertSavedTags(t *testing.T, record *core.Record, want []string) {
	t.Helper()
	var got []string
	if err := record.UnmarshalJSONField("tags", &got); err != nil {
		t.Fatalf("failed to unmarshal tags: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("tags = %#v, want %#v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("tags = %#v, want %#v", got, want)
		}
	}
}
