package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func TestSettingsReadCreatesAutoDefaultsWithoutHeader(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "settings-default-locale")

	read := serveTestRequest(t, app, http.MethodGet, "/api/app/settings", "", token)
	if read.Code != http.StatusOK {
		t.Fatalf("expected settings read 200, got %d: %s", read.Code, read.Body.String())
	}
	body := decodeAPISuccessDataForTest[settingsResponse](t, read.Body.Bytes())
	if body.Settings.LocalePreference != string(autoLocalePreference) {
		t.Fatalf("expected default locale preference auto, got %q", body.Settings.LocalePreference)
	}
	if got := countUserRecords(t, app, "settings", user.Id); got != 1 {
		t.Fatalf("expected settings read to create one settings row, got %d", got)
	}
	if got := settingsRecordLocalePreference(t, app, user.Id); got != string(autoLocalePreference) {
		t.Fatalf("expected persisted locale preference auto, got %q", got)
	}
}

func TestSettingsReadDoesNotPersistRequestLocale(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "settings-request-locale")

	first := serveTestRequestWithHeaders(t, app, http.MethodGet, "/api/app/settings", "", token, map[string]string{
		"X-Renewlet-Locale": "zh-CN",
	})
	if first.Code != http.StatusOK {
		t.Fatalf("expected first settings read 200, got %d: %s", first.Code, first.Body.String())
	}
	firstBody := decodeAPISuccessDataForTest[settingsResponse](t, first.Body.Bytes())
	if firstBody.Settings.LocalePreference != string(autoLocalePreference) {
		t.Fatalf("expected first settings locale preference auto, got %q", firstBody.Settings.LocalePreference)
	}

	second := serveTestRequestWithHeaders(t, app, http.MethodGet, "/api/app/settings", "", token, map[string]string{
		"X-Renewlet-Locale": "en-US",
	})
	if second.Code != http.StatusOK {
		t.Fatalf("expected second settings read 200, got %d: %s", second.Code, second.Body.String())
	}
	secondBody := decodeAPISuccessDataForTest[settingsResponse](t, second.Body.Bytes())
	if secondBody.Settings.LocalePreference != string(autoLocalePreference) || settingsRecordLocalePreference(t, app, user.Id) != string(autoLocalePreference) {
		t.Fatalf("expected request locale not to affect account preference, got response=%q persisted=%q", secondBody.Settings.LocalePreference, settingsRecordLocalePreference(t, app, user.Id))
	}
}

func TestSettingsUpdateCreatesAutoDefaultsRegardlessOfRequestLocale(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "settings-update-locale")

	update := serveTestRequestWithHeaders(t, app, http.MethodPut, "/api/app/settings", `{"monthlyBudget":"2333"}`, token, map[string]string{
		"X-Renewlet-Locale": "zh-CN",
	})
	if update.Code != http.StatusOK {
		t.Fatalf("expected settings update 200, got %d: %s", update.Code, update.Body.String())
	}
	body := decodeAPISuccessDataForTest[settingsResponse](t, update.Body.Bytes())
	if body.Settings.LocalePreference != string(autoLocalePreference) || body.Settings.MonthlyBudget != "2333" {
		t.Fatalf("expected update to create auto settings with monthly budget, got %#v", body.Settings)
	}
	if got := settingsRecordLocalePreference(t, app, user.Id); got != string(autoLocalePreference) {
		t.Fatalf("expected persisted locale preference auto, got %q", got)
	}
}

func TestSettingsUpdateRejectsUnsupportedOrLegacyLocaleWithoutCreatingRecord(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "settings-invalid-locale")

	update := serveTestRequestWithHeaders(t, app, http.MethodPut, "/api/app/settings", `{"localePreference":"fr-FR"}`, token, map[string]string{
		"X-Renewlet-Locale": "zh-CN",
	})
	if update.Code != http.StatusBadRequest {
		t.Fatalf("expected unsupported locale update 400, got %d: %s", update.Code, update.Body.String())
	}
	if got := countUserRecords(t, app, "settings", user.Id); got != 0 {
		t.Fatalf("expected invalid settings update not to create a settings row, got %d", got)
	}

	legacy := serveTestRequest(t, app, http.MethodPut, "/api/app/settings", `{"locale":"zh-CN"}`, token)
	if legacy.Code != http.StatusBadRequest {
		t.Fatalf("expected legacy locale field update 400, got %d: %s", legacy.Code, legacy.Body.String())
	}
	if got := countUserRecords(t, app, "settings", user.Id); got != 0 {
		t.Fatalf("expected legacy settings update not to create a settings row, got %d", got)
	}
}

func TestSettingsProductAPIRoundTripAndStrictJSON(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	_, token := createRouteTestUser(t, app, "settings-api")

	update := serveTestRequest(t, app, http.MethodPut, "/api/app/settings", `{"monthlyBudget":"2333","timezone":"Asia/Shanghai"}`, token)
	if update.Code != http.StatusOK {
		t.Fatalf("expected settings update 200, got %d: %s", update.Code, update.Body.String())
	}
	updateBody := decodeAPISuccessDataForTest[settingsResponse](t, update.Body.Bytes())
	if updateBody.Settings.MonthlyBudget != "2333" || updateBody.Settings.Timezone != "Asia/Shanghai" {
		t.Fatalf("unexpected settings response: %#v", updateBody.Settings)
	}

	read := serveTestRequest(t, app, http.MethodGet, "/api/app/settings", "", token)
	if read.Code != http.StatusOK {
		t.Fatalf("expected settings read 200, got %d: %s", read.Code, read.Body.String())
	}
	readBody := decodeAPISuccessDataForTest[settingsResponse](t, read.Body.Bytes())
	if readBody.Settings.MonthlyBudget != "2333" || readBody.Settings.Timezone != "Asia/Shanghai" {
		t.Fatalf("expected persisted settings, got %#v", readBody.Settings)
	}

	invalid := serveTestRequest(t, app, http.MethodPut, "/api/app/settings", `{"unknown":true}`, token)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("expected strict settings update 400, got %d: %s", invalid.Code, invalid.Body.String())
	}
}

func settingsRecordLocalePreference(t *testing.T, app core.App, userID string) string {
	t.Helper()
	record, err := app.FindFirstRecordByFilter("settings", "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		t.Fatal(err)
	}
	return mustSettingsFromRecord(t, record).LocalePreference
}

func mustSettingsFromRecord(t *testing.T, record *core.Record) appSettings {
	t.Helper()
	settings, err := settingsFromRecord(record)
	if err != nil {
		t.Fatal(err)
	}
	return settings
}

func TestCustomConfigProductAPIRoundTrip(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	_, token := createRouteTestUser(t, app, "custom-config-api")

	body := `{"config":{"categories":[{"id":"cat_ai","value":"ai","labels":{"zh-CN":"AI","en-US":"AI"},"color":"#10b981"}],"statuses":[],"paymentMethods":[],"currencies":[]}}`
	update := serveTestRequest(t, app, http.MethodPut, "/api/app/custom-config", body, token)
	if update.Code != http.StatusOK {
		t.Fatalf("expected custom config update 200, got %d: %s", update.Code, update.Body.String())
	}

	read := serveTestRequest(t, app, http.MethodGet, "/api/app/custom-config", "", token)
	if read.Code != http.StatusOK {
		t.Fatalf("expected custom config read 200, got %d: %s", read.Code, read.Body.String())
	}
	response := decodeAPISuccessDataForTest[customConfigResponse](t, read.Body.Bytes())
	if len(response.Config.Categories) != 1 || response.Config.Categories[0].ID != "cat_ai" {
		t.Fatalf("unexpected custom config: %#v", response.Config)
	}
}

func TestSubscriptionsProductAPIUsesOwnerScopedCRUD(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	_, token := createRouteTestUser(t, app, "subscriptions-api")
	_, otherToken := createRouteTestUser(t, app, "subscriptions-other-api")

	create := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions", subscriptionCreateBody("Route API"), token)
	if create.Code != http.StatusCreated {
		t.Fatalf("expected subscription create 201, got %d: %s", create.Code, create.Body.String())
	}
	created := decodeAPISuccessDataForTest[subscriptionResponse](t, create.Body.Bytes())
	id := created.Subscription.ID
	if id == "" {
		t.Fatalf("expected created subscription id, got %#v", created.Subscription)
	}
	stored, err := app.FindRecordById("subscriptions", id)
	if err != nil {
		t.Fatal(err)
	}
	stored.Set("pinned", true)
	stored.Set("trialEndDate", "2026-01-20")
	stored.Set("extra", map[string]interface{}{
		"import": map[string]interface{}{"source": "wallos", "sourceId": "wallos-1"},
	})
	if err := app.Save(stored); err != nil {
		t.Fatal(err)
	}

	list := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions?limit=10", "", token)
	if list.Code != http.StatusOK {
		t.Fatalf("expected subscription list 200, got %d: %s", list.Code, list.Body.String())
	}
	listBody := decodeAPISuccessDataForTest[subscriptionCollectionListResponse](t, list.Body.Bytes())
	if len(listBody.Subscriptions) != 1 || listBody.Subscriptions[0].Name != "Route API" || listBody.Total != 1 {
		t.Fatalf("unexpected subscription list: %#v", listBody)
	}
	if strings.Contains(list.Body.String(), `"user"`) {
		t.Fatalf("subscription API must not expose owner field: %#v", listBody.Subscriptions[0])
	}

	foreignDelete := serveTestRequest(t, app, http.MethodDelete, "/api/app/subscriptions/"+id, "", otherToken)
	if foreignDelete.Code != http.StatusNotFound {
		t.Fatalf("expected foreign delete 404, got %d: %s", foreignDelete.Code, foreignDelete.Body.String())
	}

	patch := serveTestRequest(t, app, http.MethodPatch, "/api/app/subscriptions/"+id, `{"name":"Renamed API","price":"20"}`, token)
	if patch.Code != http.StatusOK {
		t.Fatalf("expected subscription patch 200, got %d: %s", patch.Code, patch.Body.String())
	}
	patched := decodeAPISuccessDataForTest[subscriptionResponse](t, patch.Body.Bytes())
	if patched.Subscription.Name != "Renamed API" || patched.Subscription.Price != "20" {
		t.Fatalf("unexpected patched subscription: %#v", patched.Subscription)
	}
	if !patched.Subscription.Pinned || patched.Subscription.TrialEndDate == nil || *patched.Subscription.TrialEndDate != "2026-01-20" {
		t.Fatalf("subscription patch replaced non-form state: %#v", patched.Subscription)
	}
	importMetadata, ok := patched.Subscription.Extra["import"].(map[string]interface{})
	if !ok || importMetadata["source"] != "wallos" || importMetadata["sourceId"] != "wallos-1" {
		t.Fatalf("subscription patch replaced import metadata: %#v", patched.Subscription.Extra)
	}
	reloaded, err := app.FindRecordById("subscriptions", id)
	if err != nil {
		t.Fatal(err)
	}
	if !reloaded.GetBool("pinned") || reloaded.GetString("trialEndDate") != "2026-01-20" {
		t.Fatalf("subscription patch did not preserve persisted non-form state: pinned=%v trialEndDate=%q", reloaded.GetBool("pinned"), reloaded.GetString("trialEndDate"))
	}
	reloadedExtra := subscriptionRecordJSONMap(reloaded, "extra")
	reloadedImport, ok := reloadedExtra["import"].(map[string]interface{})
	if !ok || reloadedImport["source"] != "wallos" || reloadedImport["sourceId"] != "wallos-1" {
		t.Fatalf("subscription patch did not preserve persisted import metadata: %#v", reloadedExtra)
	}

	del := serveTestRequest(t, app, http.MethodDelete, "/api/app/subscriptions/"+id, "", token)
	if del.Code != http.StatusOK {
		t.Fatalf("expected subscription delete 200, got %d: %s", del.Code, del.Body.String())
	}
}

func TestSubscriptionsProductAPIAcceptsRecurringSubscriptionWithoutStartDate(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	_, token := createRouteTestUser(t, app, "subscriptions-null-start-api")

	var body map[string]interface{}
	if err := json.Unmarshal([]byte(subscriptionCreateBody("Unknown Start")), &body); err != nil {
		t.Fatal(err)
	}
	body["startDate"] = nil
	body["autoCalculateNextBillingDate"] = false
	data, _ := json.Marshal(body)

	create := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions", string(data), token)
	if create.Code != http.StatusCreated {
		t.Fatalf("expected subscription create 201, got %d: %s", create.Code, create.Body.String())
	}
	created := decodeAPISuccessDataForTest[subscriptionResponse](t, create.Body.Bytes())
	if created.Subscription.StartDate != nil {
		t.Fatalf("expected startDate JSON null, got %#v in %#v", created.Subscription.StartDate, created.Subscription)
	}
	if created.Subscription.AutoCalculateNextBillingDate {
		t.Fatalf("expected manual date anchor, got %#v", created.Subscription.AutoCalculateNextBillingDate)
	}
}

func TestSubscriptionsProductAPICursorAdvancesWithoutRepeatingRows(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "subscriptions-cursor-api")
	for _, name := range []string{"Cursor One", "Cursor Two", "Cursor Three"} {
		createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": name})
	}

	seen := map[string]bool{}
	cursor := ""
	for page := 0; page < 3; page++ {
		target := "/api/app/subscriptions?limit=1"
		if cursor != "" {
			target += "&cursor=" + url.QueryEscape(cursor)
		}
		res := serveTestRequest(t, app, http.MethodGet, target, "", token)
		if res.Code != http.StatusOK {
			t.Fatalf("expected subscription page %d to return 200, got %d: %s", page+1, res.Code, res.Body.String())
		}
		body := decodeAPISuccessDataForTest[subscriptionCollectionListResponse](t, res.Body.Bytes())
		if len(body.Subscriptions) != 1 {
			t.Fatalf("expected one subscription on page %d, got %#v", page+1, body.Subscriptions)
		}
		id := body.Subscriptions[0].ID
		if id == "" {
			t.Fatalf("expected page %d subscription id, got %#v", page+1, body.Subscriptions[0])
		}
		if seen[id] {
			t.Fatalf("cursor returned duplicate subscription id %q on page %d", id, page+1)
		}
		seen[id] = true
		if page < 2 {
			if body.NextCursor == nil || *body.NextCursor == "" {
				t.Fatalf("expected next cursor on page %d", page+1)
			}
			cursor = *body.NextCursor
		} else if body.NextCursor != nil {
			t.Fatalf("expected final page to end cursor, got %q", *body.NextCursor)
		}
	}
}

func TestSubscriptionsProductAPIFiltersEffectiveStatusAndCursorTotal(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "subscriptions-status-filter-api")

	legacyOverdue := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":            "Legacy Overdue",
		"status":          "active",
		"billingCycle":    "monthly",
		"startDate":       "1999-01-01",
		"nextBillingDate": "2000-01-01",
	})
	storedExpired := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":            "Stored Expired",
		"status":          "expired",
		"nextBillingDate": "2999-01-01",
	})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":             "One Time Buyout",
		"status":           "active",
		"billingCycle":     "one-time",
		"oneTimeTermCount": 0,
		"startDate":        "1999-01-01",
		"nextBillingDate":  "2000-01-01",
	})

	res := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions?status=expired&limit=1", "", token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected expired filtered list 200, got %d: %s", res.Code, res.Body.String())
	}
	first := decodeAPISuccessDataForTest[subscriptionCollectionListResponse](t, res.Body.Bytes())
	if first.Total != 2 || len(first.Subscriptions) != 1 || first.NextCursor == nil {
		t.Fatalf("expected first filtered page to expose total=2 and next cursor, got %#v", first)
	}
	if got := first.Subscriptions[0].ID; got != legacyOverdue.Id && got != storedExpired.Id {
		t.Fatalf("expected first filtered page to contain an expired match, got %#v", first.Subscriptions[0])
	}

	next := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions?status=expired&limit=1&cursor="+url.QueryEscape(*first.NextCursor), "", token)
	if next.Code != http.StatusOK {
		t.Fatalf("expected second expired filtered page 200, got %d: %s", next.Code, next.Body.String())
	}
	second := decodeAPISuccessDataForTest[subscriptionCollectionListResponse](t, next.Body.Bytes())
	if second.Total != 2 || len(second.Subscriptions) != 1 || second.NextCursor != nil {
		t.Fatalf("expected second filtered page to keep total=2 and finish cursor, got %#v", second)
	}
	secondID := second.Subscriptions[0].ID
	firstID := first.Subscriptions[0].ID
	if secondID == "" || secondID == firstID {
		t.Fatalf("expected filtered cursor to advance to another expired row, first=%q second=%q", firstID, secondID)
	}

	invalid := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions?pinned=nope", "", token)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid boolean filter 400, got %d: %s", invalid.Code, invalid.Body.String())
	}
}

func TestAssetsProductAPIUploadListAndRead(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	_, token := createRouteTestUser(t, app, "assets-api")

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
	if upload.Code != http.StatusCreated {
		t.Fatalf("expected asset upload 201, got %d: %s", upload.Code, upload.Body.String())
	}
	uploaded := decodeAPISuccessDataForTest[uploadAssetResponse](t, upload.Body.Bytes())
	if !strings.HasPrefix(uploaded.URL, "/api/app/assets/") {
		t.Fatalf("expected product asset URL, got %#v", uploaded)
	}
	id := strings.TrimPrefix(uploaded.URL, "/api/app/assets/")

	list := serveTestRequest(t, app, http.MethodGet, "/api/app/assets?kind=logo&page=1&perPage=48", "", token)
	if list.Code != http.StatusOK {
		t.Fatalf("expected asset list 200, got %d: %s", list.Code, list.Body.String())
	}
	page := decodeAPISuccessDataForTest[uploadedAssetsPageResponse](t, list.Body.Bytes())
	if len(page.Items) != 1 || page.Items[0].URL != uploaded.URL || page.Items[0].Kind != "logo" {
		t.Fatalf("unexpected asset page: %#v", page)
	}

	read := serveTestRequest(t, app, http.MethodGet, "/api/app/assets/"+id, "", token)
	if read.Code != http.StatusOK {
		t.Fatalf("expected asset read 200, got %d: %s", read.Code, read.Body.String())
	}
	if contentType := read.Header().Get("content-type"); !strings.Contains(contentType, "image/svg+xml") {
		t.Fatalf("expected svg content-type, got %q", contentType)
	}

	del := serveTestRequest(t, app, http.MethodDelete, "/api/app/assets/"+id, "", token)
	if del.Code != http.StatusOK {
		t.Fatalf("expected asset delete 200, got %d: %s", del.Code, del.Body.String())
	}
	afterDeleteList := serveTestRequest(t, app, http.MethodGet, "/api/app/assets?kind=logo&page=1&perPage=48", "", token)
	if afterDeleteList.Code != http.StatusOK {
		t.Fatalf("expected asset list after delete 200, got %d: %s", afterDeleteList.Code, afterDeleteList.Body.String())
	}
	afterDeletePage := decodeAPISuccessDataForTest[uploadedAssetsPageResponse](t, afterDeleteList.Body.Bytes())
	if len(afterDeletePage.Items) != 0 {
		t.Fatalf("expected deleted asset to disappear from list: %#v", afterDeletePage)
	}
	readDeleted := serveTestRequest(t, app, http.MethodGet, "/api/app/assets/"+id, "", token)
	if readDeleted.Code != http.StatusNotFound {
		t.Fatalf("expected deleted asset read 404, got %d: %s", readDeleted.Code, readDeleted.Body.String())
	}

	invalid := serveMultipartTestRequest(t, app, "/api/app/assets", token, map[string]string{"kind": "logo"}, "file", "note.txt", "plain text")
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid upload 400, got %d: %s", invalid.Code, invalid.Body.String())
	}
}

func TestAssetProductAPIDeleteBlocksReferencedAndForeignAssets(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "assets-owner")
	_, foreignToken := createRouteTestUser(t, app, "assets-foreign")

	upload := serveMultipartTestRequest(
		t,
		app,
		"/api/app/assets",
		token,
		map[string]string{"kind": "logo"},
		"file",
		"used.svg",
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`,
	)
	if upload.Code != http.StatusCreated {
		t.Fatalf("expected asset upload 201, got %d: %s", upload.Code, upload.Body.String())
	}
	uploaded := decodeAPISuccessDataForTest[uploadAssetResponse](t, upload.Body.Bytes())
	id := strings.TrimPrefix(uploaded.URL, "/api/app/assets/")
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"logo": uploaded.URL})

	foreignDelete := serveTestRequest(t, app, http.MethodDelete, "/api/app/assets/"+id, "", foreignToken)
	if foreignDelete.Code != http.StatusNotFound {
		t.Fatalf("expected foreign asset delete 404, got %d: %s", foreignDelete.Code, foreignDelete.Body.String())
	}

	blockedDelete := serveTestRequest(t, app, http.MethodDelete, "/api/app/assets/"+id, "", token)
	if blockedDelete.Code != http.StatusConflict {
		t.Fatalf("expected referenced asset delete 409, got %d: %s", blockedDelete.Code, blockedDelete.Body.String())
	}
	var blockedBody struct {
		Error struct {
			Code    string            `json:"code"`
			Details assetInUseDetails `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(blockedDelete.Body.Bytes(), &blockedBody); err != nil {
		t.Fatal(err)
	}
	if blockedBody.Error.Code != "ASSET_IN_USE" || blockedBody.Error.Details.UsageCount != 1 || blockedBody.Error.Details.SubscriptionLogoCount != 1 || blockedBody.Error.Details.PaymentMethodIconCount != 0 {
		t.Fatalf("unexpected referenced delete body: %#v", blockedBody)
	}

	read := serveTestRequest(t, app, http.MethodGet, "/api/app/assets/"+id, "", token)
	if read.Code != http.StatusOK {
		t.Fatalf("expected referenced asset to remain readable, got %d: %s", read.Code, read.Body.String())
	}
}

func TestAssetProductAPIDeleteBlocksPaymentMethodIconReferences(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "assets-payment-owner")

	upload := serveMultipartTestRequest(
		t,
		app,
		"/api/app/assets",
		token,
		map[string]string{"kind": "icon"},
		"file",
		"payment.svg",
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`,
	)
	if upload.Code != http.StatusCreated {
		t.Fatalf("expected icon upload 201, got %d: %s", upload.Code, upload.Body.String())
	}
	uploaded := decodeAPISuccessDataForTest[uploadAssetResponse](t, upload.Body.Bytes())
	id := strings.TrimPrefix(uploaded.URL, "/api/app/assets/")
	createCalendarFeedTestCustomConfig(t, app, user.Id, func(config *customConfigPayload) {
		config.PaymentMethods = []customConfigItem{{
			ID:     "card",
			Value:  "card",
			Labels: customConfigLabels{ZhCN: "银行卡", EnUS: "Card"},
			Icon:   uploaded.URL,
		}}
	})

	blockedDelete := serveTestRequest(t, app, http.MethodDelete, "/api/app/assets/"+id, "", token)
	if blockedDelete.Code != http.StatusConflict {
		t.Fatalf("expected payment-method icon delete 409, got %d: %s", blockedDelete.Code, blockedDelete.Body.String())
	}
	var blockedBody struct {
		Error struct {
			Code    string            `json:"code"`
			Details assetInUseDetails `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(blockedDelete.Body.Bytes(), &blockedBody); err != nil {
		t.Fatal(err)
	}
	if blockedBody.Error.Code != "ASSET_IN_USE" || blockedBody.Error.Details.UsageCount != 1 || blockedBody.Error.Details.SubscriptionLogoCount != 0 || blockedBody.Error.Details.PaymentMethodIconCount != 1 {
		t.Fatalf("unexpected payment-method referenced delete body: %#v", blockedBody)
	}

	read := serveTestRequest(t, app, http.MethodGet, "/api/app/assets/"+id, "", token)
	if read.Code != http.StatusOK {
		t.Fatalf("expected referenced payment icon to remain readable, got %d: %s", read.Code, read.Body.String())
	}
}

func TestAssetProductAPIDeleteReportsMixedReferencesAndIgnoresForeignConfig(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "assets-mixed-owner")
	foreignUser, _ := createRouteTestUser(t, app, "assets-mixed-foreign")

	upload := serveMultipartTestRequest(
		t,
		app,
		"/api/app/assets",
		token,
		map[string]string{"kind": "logo"},
		"file",
		"mixed.svg",
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`,
	)
	if upload.Code != http.StatusCreated {
		t.Fatalf("expected mixed asset upload 201, got %d: %s", upload.Code, upload.Body.String())
	}
	uploaded := decodeAPISuccessDataForTest[uploadAssetResponse](t, upload.Body.Bytes())
	id := strings.TrimPrefix(uploaded.URL, "/api/app/assets/")
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"logo": uploaded.URL})
	createCalendarFeedTestCustomConfig(t, app, user.Id, func(config *customConfigPayload) {
		config.PaymentMethods = []customConfigItem{{
			ID:     "paypal",
			Value:  "paypal",
			Labels: customConfigLabels{ZhCN: "PayPal", EnUS: "PayPal"},
			Icon:   uploaded.URL,
		}}
	})
	createCalendarFeedTestCustomConfig(t, app, foreignUser.Id, func(config *customConfigPayload) {
		config.PaymentMethods = []customConfigItem{{
			ID:     "foreign_card",
			Value:  "foreign_card",
			Labels: customConfigLabels{ZhCN: "外部", EnUS: "Foreign"},
			Icon:   uploaded.URL,
		}}
	})

	blockedDelete := serveTestRequest(t, app, http.MethodDelete, "/api/app/assets/"+id, "", token)
	if blockedDelete.Code != http.StatusConflict {
		t.Fatalf("expected mixed referenced asset delete 409, got %d: %s", blockedDelete.Code, blockedDelete.Body.String())
	}
	var blockedBody struct {
		Error struct {
			Code    string            `json:"code"`
			Details assetInUseDetails `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(blockedDelete.Body.Bytes(), &blockedBody); err != nil {
		t.Fatal(err)
	}
	if blockedBody.Error.Code != "ASSET_IN_USE" || blockedBody.Error.Details.UsageCount != 2 || blockedBody.Error.Details.SubscriptionLogoCount != 1 || blockedBody.Error.Details.PaymentMethodIconCount != 1 {
		t.Fatalf("unexpected mixed referenced delete body: %#v", blockedBody)
	}
}

func TestAssetProductAPIDeleteIgnoresForeignCustomConfigReferences(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	owner, token := createRouteTestUser(t, app, "assets-foreign-config-owner")
	foreignUser, _ := createRouteTestUser(t, app, "assets-foreign-config-other")

	upload := serveMultipartTestRequest(
		t,
		app,
		"/api/app/assets",
		token,
		map[string]string{"kind": "icon"},
		"file",
		"unused-by-owner.svg",
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`,
	)
	if upload.Code != http.StatusCreated {
		t.Fatalf("expected owner icon upload 201, got %d: %s", upload.Code, upload.Body.String())
	}
	uploaded := decodeAPISuccessDataForTest[uploadAssetResponse](t, upload.Body.Bytes())
	createCalendarFeedTestCustomConfig(t, app, foreignUser.Id, func(config *customConfigPayload) {
		config.PaymentMethods = []customConfigItem{{
			ID:     "foreign_card",
			Value:  "foreign_card",
			Labels: customConfigLabels{ZhCN: "外部", EnUS: "Foreign"},
			Icon:   uploaded.URL,
		}}
	})

	id := strings.TrimPrefix(uploaded.URL, "/api/app/assets/")
	del := serveTestRequest(t, app, http.MethodDelete, "/api/app/assets/"+id, "", token)
	if del.Code != http.StatusOK {
		t.Fatalf("expected foreign custom config reference to be ignored for owner %s, got %d: %s", owner.Id, del.Code, del.Body.String())
	}
}

func subscriptionCreateBody(name string) string {
	body := map[string]interface{}{
		"name":                         name,
		"logo":                         nil,
		"price":                        "12",
		"currency":                     "USD",
		"billingCycle":                 "monthly",
		"customDays":                   nil,
		"customCycleUnit":              nil,
		"oneTimeTermCount":             nil,
		"oneTimeTermUnit":              nil,
		"category":                     "productivity",
		"status":                       "active",
		"pinned":                       false,
		"publicHidden":                 false,
		"paymentMethod":                nil,
		"startDate":                    "2026-01-01",
		"nextBillingDate":              "2026-02-01",
		"autoRenew":                    false,
		"autoCalculateNextBillingDate": true,
		"website":                      nil,
		"notes":                        nil,
		"tags":                         []string{"api"},
		"reminderDays":                 3,
		"repeatReminderEnabled":        false,
		"repeatReminderInterval":       defaultRepeatReminderInterval,
		"repeatReminderWindow":         defaultRepeatReminderWindow,
	}
	data, _ := json.Marshal(body)
	return string(data)
}
