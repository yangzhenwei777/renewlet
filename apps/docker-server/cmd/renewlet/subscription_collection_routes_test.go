package main

import (
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
)

type subscriptionCollectionContractFixture struct {
	Version                  int                         `json:"version"`
	CollectionLimit          int                         `json:"collectionLimit"`
	ManifestRoutes           []subscriptionManifestRoute `json:"manifestRoutes"`
	CollectionResponseRoutes []string                    `json:"collectionResponseRoutes"`
	BoundedCollectionRoutes  []string                    `json:"boundedCollectionRoutes"`
	InvalidQueryRoutes       []string                    `json:"invalidQueryRoutes"`
	DetailOnlyFields         []string                    `json:"detailOnlyFields"`
	CollectionItems          []map[string]interface{}    `json:"collectionItems"`
	CompleteSubscription     map[string]interface{}      `json:"completeSubscription"`
}

func TestSubscriptionCollectionMapperMatchesSharedCycleFixtures(t *testing.T) {
	fixture := loadSubscriptionCollectionContractFixture(t)
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, _ := createRouteTestUser(t, app, "subscription-collection-cycle-fixtures")

	for _, expected := range fixture.CollectionItems {
		overrides := make(map[string]interface{}, len(expected))
		for field, value := range expected {
			if field != "id" {
				overrides[field] = value
			}
		}
		record := createRouteTestSubscription(t, app, user.Id, overrides)
		encoded, err := json.Marshal(subscriptionCollectionAPIFromRecord(record))
		if err != nil {
			t.Fatal(err)
		}
		var actual map[string]interface{}
		if err := json.Unmarshal(encoded, &actual); err != nil {
			t.Fatal(err)
		}
		for field, expectedValue := range expected {
			if field == "id" {
				continue
			}
			if !reflect.DeepEqual(actual[field], expectedValue) {
				t.Fatalf("%s field %q = %#v, want %#v", expected["id"], field, actual[field], expectedValue)
			}
		}
		for _, field := range []string{"customDays", "customCycleUnit", "oneTimeTermCount", "oneTimeTermUnit"} {
			if _, expectedField := expected[field]; expectedField {
				continue
			}
			if _, actualField := actual[field]; actualField {
				t.Fatalf("%s must omit cycle field %q: %#v", expected["id"], field, actual)
			}
		}
	}
}

type subscriptionManifestRoute struct {
	Path    string   `json:"path"`
	Methods []string `json:"methods"`
}

type subscriptionCollectionMapResponse struct {
	Subscriptions []map[string]interface{} `json:"subscriptions"`
}

func TestSubscriptionCollectionRoutesKeepLightweightAndCompleteShapesSeparate(t *testing.T) {
	fixture := loadSubscriptionCollectionContractFixture(t)
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "subscription-collections")
	foreignUser, foreignToken := createRouteTestUser(t, app, "subscription-collections-foreign")
	target := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":                  "Collection Target",
		"category":              "productivity",
		"website":               "https://target.example.com",
		"notes":                 "private detail",
		"tags":                  []string{"AI", "Team"},
		"repeatReminderEnabled": true,
		"extra":                 map[string]interface{}{"source": "route-test"},
	})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":            "Collection Hidden",
		"category":        "entertainment",
		"publicHidden":    true,
		"nextBillingDate": "2026-03-01",
		"tags":            []string{"Team"},
	})
	createRouteTestSubscription(t, app, foreignUser.Id, map[string]interface{}{
		"name": "Foreign Collection",
		"tags": []string{"Foreign"},
	})

	for _, targetURL := range fixture.CollectionResponseRoutes {
		response := serveTestRequest(t, app, http.MethodGet, targetURL, "", token)
		if response.Code != http.StatusOK {
			t.Fatalf("expected %s to return 200, got %d: %s", targetURL, response.Code, response.Body.String())
		}
		body := decodeAPISuccessDataForTest[subscriptionCollectionMapResponse](t, response.Body.Bytes())
		if len(body.Subscriptions) != 2 {
			t.Fatalf("expected %s to return two owner rows, got %#v", targetURL, body.Subscriptions)
		}
		for _, subscription := range body.Subscriptions {
			assertSubscriptionCollectionItemShape(t, subscription, fixture)
		}
	}

	detailResponse := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions/"+target.Id, "", token)
	if detailResponse.Code != http.StatusOK {
		t.Fatalf("expected detail 200, got %d: %s", detailResponse.Code, detailResponse.Body.String())
	}
	detail := decodeAPISuccessDataForTest[subscriptionResponse](t, detailResponse.Body.Bytes()).Subscription
	detailMap, err := subscriptionDetailResponseMap(detail)
	if err != nil {
		t.Fatal(err)
	}
	for field := range fixture.CompleteSubscription {
		if _, ok := detailMap[field]; !ok {
			t.Fatalf("detail response must contain shared fixture field %q: %#v", field, detailMap)
		}
	}

	exportResponse := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions/export", "", token)
	if exportResponse.Code != http.StatusOK {
		t.Fatalf("expected export 200, got %d: %s", exportResponse.Code, exportResponse.Body.String())
	}
	exported := decodeAPISuccessDataForTest[subscriptionCollectionMapResponse](t, exportResponse.Body.Bytes())
	if len(exported.Subscriptions) != 2 {
		t.Fatalf("expected export to contain two complete owner rows, got %#v", exported.Subscriptions)
	}
	for _, subscription := range exported.Subscriptions {
		if _, ok := subscription["autoCalculateNextBillingDate"]; !ok {
			t.Fatalf("export must keep complete DTO fields: %#v", subscription)
		}
	}

	foreignDetail := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions/"+target.Id, "", foreignToken)
	if foreignDetail.Code != http.StatusNotFound {
		t.Fatalf("expected foreign detail to remain owner-scoped, got %d: %s", foreignDetail.Code, foreignDetail.Body.String())
	}
}

func TestSubscriptionFacetsUseOwnerScopedDerivedData(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "subscription-facets")
	foreignUser, _ := createRouteTestUser(t, app, "subscription-facets-foreign")
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"category": "productivity",
		"tags":     []string{"AI", "Team"},
	})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"category":     "entertainment",
		"publicHidden": true,
		"tags":         []string{"Team"},
	})
	createRouteTestSubscription(t, app, foreignUser.Id, map[string]interface{}{
		"category": "foreign",
		"tags":     []string{"Foreign"},
	})

	response := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions/facets", "", token)
	if response.Code != http.StatusOK {
		t.Fatalf("expected facets 200, got %d: %s", response.Code, response.Body.String())
	}
	facets := decodeAPISuccessDataForTest[subscriptionFacetsResponse](t, response.Body.Bytes())
	if facets.Total != 2 || facets.VisibleCount != 1 || facets.HiddenCount != 1 {
		t.Fatalf("unexpected owner facet counts: %#v", facets)
	}
	if facets.CategoryCounts["productivity"] != 1 || facets.CategoryCounts["entertainment"] != 1 || facets.CategoryCounts["foreign"] != 0 {
		t.Fatalf("unexpected owner category counts: %#v", facets.CategoryCounts)
	}
	if strings.Join(facets.Tags, ",") != "AI,Team" {
		t.Fatalf("unexpected owner tags: %#v", facets.Tags)
	}
}

func TestSubscriptionBoundedCollectionsReject5001WithoutReadingFacts(t *testing.T) {
	fixture := loadSubscriptionCollectionContractFixture(t)
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "subscription-collection-limit")
	seedSubscriptionCollectionProjectionOverflow(t, app, user.Id, fixture.CollectionLimit)

	for _, targetURL := range fixture.BoundedCollectionRoutes {
		response := serveTestRequest(t, app, http.MethodGet, targetURL, "", token)
		if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "SUBSCRIPTION_COLLECTION_LIMIT_EXCEEDED") {
			t.Fatalf("expected %s to reject 5001 rows with structured 422, got %d: %s", targetURL, response.Code, response.Body.String())
		}
	}
}

func TestSubscriptionCollectionQueriesRejectOutOfContractParameters(t *testing.T) {
	fixture := loadSubscriptionCollectionContractFixture(t)
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	_, token := createRouteTestUser(t, app, "subscription-collection-query")

	for _, targetURL := range fixture.InvalidQueryRoutes {
		response := serveTestRequest(t, app, http.MethodGet, targetURL, "", token)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("expected %s to reject out-of-contract query, got %d: %s", targetURL, response.Code, response.Body.String())
		}
	}
}

func assertSubscriptionCollectionItemShape(t *testing.T, subscription map[string]interface{}, fixture subscriptionCollectionContractFixture) {
	t.Helper()
	if len(fixture.CollectionItems) == 0 {
		t.Fatal("shared collection fixture must contain cycle items")
	}
	for field := range fixture.CollectionItems[0] {
		if _, ok := subscription[field]; !ok {
			t.Fatalf("collection item is missing shared fixture field %q: %#v", field, subscription)
		}
	}
	for _, field := range fixture.DetailOnlyFields {
		if _, ok := subscription[field]; ok {
			t.Fatalf("collection item must not expose detail field %q: %#v", field, subscription)
		}
	}
}

func seedSubscriptionCollectionProjectionOverflow(t *testing.T, app interface{ DB() dbx.Builder }, userID string, limit int) {
	t.Helper()
	_, err := app.DB().NewQuery(`WITH digits(value) AS (
		VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
	), sequence(number) AS (
		SELECT ones.value + tens.value * 10 + hundreds.value * 100 + thousands.value * 1000 + 1
		FROM digits AS ones
		CROSS JOIN digits AS tens
		CROSS JOIN digits AS hundreds
		CROSS JOIN digits AS thousands
		LIMIT {:rows}
	)
	INSERT INTO subscription_list_index (
		subscription_id, user_id, name, website, notes, search_text_lower, category, billing_cycle,
		currency, payment_method, status, pinned, public_hidden, next_billing_date, trial_end_date,
		one_time_term_count, auto_renew, reminder_days, repeat_reminder_enabled, created_at, updated_at
	)
	SELECT printf('overflow-%05d', number), {:user}, 'Overflow', '', '', 'overflow', 'productivity',
		'monthly', 'USD', '', 'active', 0, 0, '2026-06-01', '', 0, 0, 3, 0,
		printf('%05d', number), printf('%05d', number)
	FROM sequence`).Bind(dbx.Params{"user": userID, "rows": limit + 1}).Execute()
	if err != nil {
		t.Fatal(err)
	}
}

func loadSubscriptionCollectionContractFixture(t *testing.T) subscriptionCollectionContractFixture {
	t.Helper()
	data, err := os.ReadFile("../../../../packages/shared/src/contract-fixtures/subscription-collection-contract-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture subscriptionCollectionContractFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Version != 1 || fixture.CollectionLimit != subscriptionCollectionLimit || len(fixture.CollectionItems) != 4 {
		t.Fatalf("invalid subscription collection contract fixture: %#v", fixture)
	}
	return fixture
}
