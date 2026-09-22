package main

import (
	"net/http"
	"net/url"
	"testing"
)

func TestSubscriptionsProductAPIFiltersAcrossOwnerScopedDataset(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "subscriptions-filter-api")
	foreignUser, _ := createRouteTestUser(t, app, "subscriptions-filter-foreign")

	target := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":                  "Cursor Team Plan",
		"category":              "developer_tools",
		"tags":                  []string{"AI", "Team"},
		"billingCycle":          "monthly",
		"currency":              "USD",
		"paymentMethod":         "paypal",
		"autoRenew":             true,
		"nextBillingDate":       "2999-08-15",
		"pinned":                true,
		"publicHidden":          false,
		"reminderDays":          5,
		"repeatReminderEnabled": true,
		"website":               "https://cursor.example.com",
		"notes":                 "engineering seats",
	})
	manual := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":            "Cursor Personal",
		"category":        "developer_tools",
		"tags":            []string{"Personal"},
		"paymentMethod":   "card",
		"autoRenew":       false,
		"nextBillingDate": "2999-08-15",
	})
	buyout := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":             "Cursor Lifetime",
		"billingCycle":     "one-time",
		"oneTimeTermCount": 0,
		"startDate":        "2999-08-15",
		"nextBillingDate":  "2999-08-15",
	})
	fixed := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":             "Cursor Fixed Term",
		"billingCycle":     "one-time",
		"oneTimeTermCount": 6,
		"oneTimeTermUnit":  "month",
		"startDate":        "2999-02-15",
		"nextBillingDate":  "2999-08-15",
	})
	createRouteTestSubscription(t, app, foreignUser.Id, map[string]interface{}{
		"name":                  "Cursor Team Plan",
		"category":              "developer_tools",
		"tags":                  []string{"AI", "Team"},
		"billingCycle":          "monthly",
		"currency":              "USD",
		"paymentMethod":         "paypal",
		"autoRenew":             true,
		"nextBillingDate":       "2999-08-15",
		"pinned":                true,
		"publicHidden":          false,
		"reminderDays":          5,
		"repeatReminderEnabled": true,
	})

	values := url.Values{}
	values.Set("limit", "10")
	values.Set("q", "cursor")
	values.Add("category", "developer_tools")
	values.Add("tag", "AI")
	values.Add("billingCycle", "monthly")
	values.Add("paymentMethod", "paypal")
	values.Add("currency", "USD")
	values.Set("status", "active")
	values.Set("paymentType", "auto")
	values.Set("nextBillingFrom", "2999-08-01")
	values.Set("nextBillingTo", "2999-08-31")
	values.Set("pinned", "true")
	values.Set("publicHidden", "false")
	values.Set("reminderMode", "custom")
	values.Set("repeatReminder", "true")

	res := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions?"+values.Encode(), "", token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected filtered subscription list 200, got %d: %s", res.Code, res.Body.String())
	}
	body := decodeAPISuccessDataForTest[subscriptionCollectionListResponse](t, res.Body.Bytes())
	if body.Total != 1 || len(body.Subscriptions) != 1 {
		t.Fatalf("expected exactly one filtered subscription, got %#v", body)
	}
	if got := body.Subscriptions[0].ID; got != target.Id {
		t.Fatalf("expected owner target subscription %q, got %#v", target.Id, body.Subscriptions[0])
	}

	for paymentType, expectedID := range map[string]string{
		"auto":                target.Id,
		"manual":              manual.Id,
		"one-time-buyout":     buyout.Id,
		"one-time-fixed-term": fixed.Id,
	} {
		response := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions?limit=10&paymentType="+url.QueryEscape(paymentType), "", token)
		if response.Code != http.StatusOK {
			t.Fatalf("expected paymentType=%s to return 200, got %d: %s", paymentType, response.Code, response.Body.String())
		}
		filtered := decodeAPISuccessDataForTest[subscriptionCollectionListResponse](t, response.Body.Bytes())
		if filtered.Total != 1 || len(filtered.Subscriptions) != 1 || filtered.Subscriptions[0].ID != expectedID {
			t.Fatalf("paymentType=%s returned %#v, want only %s", paymentType, filtered, expectedID)
		}
	}

	dateRange := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions?limit=10&nextBillingFrom=2999-08-01&nextBillingTo=2999-08-31", "", token)
	if dateRange.Code != http.StatusOK {
		t.Fatalf("expected renewal/expiry date range to return 200, got %d: %s", dateRange.Code, dateRange.Body.String())
	}
	ranged := decodeAPISuccessDataForTest[subscriptionCollectionListResponse](t, dateRange.Body.Bytes())
	if ranged.Total != 3 {
		t.Fatalf("expected date range to keep recurring and fixed-term rows but exclude buyout, got %#v", ranged)
	}
}
