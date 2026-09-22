package main

import (
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
)

func TestPrivateSubscriptionCursorContract(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "subscriptions-private-cursor")
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Cursor One"})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Cursor Two"})

	response := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions?limit=1", "", token)
	if response.Code != http.StatusOK {
		t.Fatalf("expected private cursor page 200, got %d: %s", response.Code, response.Body.String())
	}
	body := decodeAPISuccessDataForTest[subscriptionCollectionListResponse](t, response.Body.Bytes())
	if body.NextCursor == nil {
		t.Fatal("expected private next cursor")
	}
	parsed, err := parsePrivateSubscriptionCursorPayload(*body.NextCursor)
	if err != nil || parsed.Version != 1 || !isValidDateOnly(parsed.AsOf) {
		t.Fatalf("expected versioned private cursor with frozen asOf, got %#v err=%v", parsed, err)
	}
	if got := subscriptionQueryToday(nil, nil, subscriptionListQuery{Cursor: &parsed}); got != parsed.AsOf {
		t.Fatalf("expected subsequent pages to freeze cursor asOf, got %q", got)
	}

	invalidCursors := []string{
		base64.StdEncoding.EncodeToString([]byte(`{"createdAt":"2026-01-01","id":"legacy"}`)),
		base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"asOf":"2026-01-01","createdAt":"2026-01-01","id":"cursor"}`)),
		base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"asOf":"2026-01-01","pinned":0,"inactive":0,"createdAt":"2026-01-01","id":"cursor","extra":true}`)),
	}
	for _, cursor := range invalidCursors {
		invalid := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions?limit=1&cursor="+url.QueryEscape(cursor), "", token)
		if invalid.Code != http.StatusBadRequest || !strings.Contains(invalid.Body.String(), `"code":"INVALID_CURSOR"`) {
			t.Fatalf("expected invalid private cursor to be rejected, got %d: %s", invalid.Code, invalid.Body.String())
		}
	}
}

func TestSubscriptionProjectionModesKeepDistinctCollectionScope(t *testing.T) {
	base := subscriptionProjectionBaseQuery("owner-projection-scope", subscriptionListQuery{})
	base.params["today"] = "2026-08-18"

	exact := buildSubscriptionProjectionPagePlan(base, 51, nil, subscriptionProjectionExactPage, 0)
	if strings.Contains(exact.SQL, "candidates AS MATERIALIZED") || !strings.Contains(exact.SQL, "SELECT COUNT(*) AS total_count FROM filtered") {
		t.Fatalf("exact page must count the complete filtered collection:\n%s", exact.SQL)
	}

	bounded := buildSubscriptionProjectionPagePlan(base, 5_001, nil, subscriptionProjectionBoundedCollection, 5_001)
	candidateLimitAt := strings.Index(bounded.SQL, "LIMIT {:candidateLimit}")
	firstOrderAt := strings.Index(bounded.SQL, "ORDER BY")
	if !strings.Contains(bounded.SQL, "candidates AS MATERIALIZED") || candidateLimitAt < 0 || firstOrderAt < candidateLimitAt {
		t.Fatalf("bounded collection must cap materialized candidates before lifecycle sorting:\n%s", bounded.SQL)
	}

	orderedWindow := buildSubscriptionProjectionPagePlan(base, 501, nil, subscriptionProjectionOrderedWindow, 0)
	if strings.Contains(orderedWindow.SQL, "candidates AS MATERIALIZED") || strings.Contains(orderedWindow.SQL, "totals AS") ||
		!strings.Contains(orderedWindow.SQL, "ORDER BY idx.pinned DESC, idx.inactive ASC") {
		t.Fatalf("ordered window must sort the complete filtered collection without exact total:\n%s", orderedWindow.SQL)
	}
}

func TestSubscriptionsProductAPIDefaultOrderKeepsPinnedIntentBeforeLifecycle(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "subscriptions-lifecycle-order")
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name": "Pinned Inactive", "pinned": true, "status": "cancelled", "nextBillingDate": "2999-01-01",
	})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name": "Pinned Active", "pinned": true, "status": "active", "nextBillingDate": "2999-01-01",
	})
	createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name": "Regular Inactive", "status": "expired", "nextBillingDate": "2999-01-01",
	})
	regularActive := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name": "Regular Active", "status": "active", "nextBillingDate": "2999-01-01",
	})
	regularActiveTie := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name": "Regular Active Tie", "status": "active", "nextBillingDate": "2999-01-01",
	})
	if _, err := app.DB().NewQuery("UPDATE subscriptions SET created = {:created} WHERE id = {:id}").
		Bind(dbx.Params{"created": regularActive.GetDateTime("created").String(), "id": regularActiveTie.Id}).
		Execute(); err != nil {
		t.Fatal(err)
	}
	if err := rebuildSubscriptionDerivedStateForUser(app, user.Id, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	names := make([]string, 0, 5)
	cursor := ""
	for page := 0; page < 5; page++ {
		target := "/api/app/subscriptions?limit=1"
		if cursor != "" {
			target += "&cursor=" + url.QueryEscape(cursor)
		}
		response := serveTestRequest(t, app, http.MethodGet, target, "", token)
		if response.Code != http.StatusOK {
			t.Fatalf("expected lifecycle page %d to return 200, got %d: %s", page+1, response.Code, response.Body.String())
		}
		body := decodeAPISuccessDataForTest[subscriptionCollectionListResponse](t, response.Body.Bytes())
		if len(body.Subscriptions) != 1 {
			t.Fatalf("expected one lifecycle item on page %d, got %#v", page+1, body.Subscriptions)
		}
		names = append(names, body.Subscriptions[0].Name)
		if body.NextCursor != nil {
			cursor = *body.NextCursor
		}
	}
	regularNames := []string{"Regular Active", "Regular Active Tie"}
	if regularActive.Id < regularActiveTie.Id {
		regularNames[0], regularNames[1] = regularNames[1], regularNames[0]
	}
	want := strings.Join([]string{"Pinned Active", "Pinned Inactive", regularNames[0], regularNames[1], "Regular Inactive"}, ",")
	if got := strings.Join(names, ","); got != want {
		t.Fatalf("unexpected lifecycle default order: %s", got)
	}
}
