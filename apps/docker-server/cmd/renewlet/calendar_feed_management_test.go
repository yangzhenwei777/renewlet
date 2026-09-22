package main

import (
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func TestCalendarFeedManagementListAndOwnerIsolation(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "user")
	otherUser, otherToken := createRouteTestUser(t, app, "admin")
	first := createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name: "Fastmail", BillingCycle: "monthly", Status: "active", NextBillingDate: "2099-06-01",
	})
	second := createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name: "GitHub", BillingCycle: "monthly", Status: "paused", NextBillingDate: "2099-06-02",
	})
	foreign := createCalendarFeedTestSubscription(t, app, otherUser.Id, calendarFeedTestSubscription{
		Name: "Foreign", BillingCycle: "monthly", Status: "active", NextBillingDate: "2099-06-03",
	})

	for _, request := range []struct {
		target string
		token  string
	}{
		{target: "/api/app/calendar-feed", token: token},
		{target: "/api/app/subscriptions/" + first.Id + "/calendar-feed", token: token},
		{target: "/api/app/subscriptions/" + second.Id + "/calendar-feed", token: token},
		{target: "/api/app/calendar-feed", token: otherToken},
		{target: "/api/app/subscriptions/" + foreign.Id + "/calendar-feed", token: otherToken},
	} {
		response := serveTestRequest(t, app, http.MethodPost, request.target, `{}`, request.token)
		if response.Code != http.StatusOK {
			t.Fatalf("create %s: %d %s", request.target, response.Code, response.Body.String())
		}
	}
	if _, err := app.DB().NewQuery(`UPDATE calendar_feeds SET updated = '2026-08-20T00:00:00Z'
		WHERE user = {:user} AND subscriptionId = {:subscription}`).Bind(dbx.Params{
		"user": user.Id, "subscription": first.Id,
	}).Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery(`UPDATE calendar_feeds SET updated = '2026-08-20T00:00:00Z'
		WHERE user = {:user} AND subscriptionId = {:subscription}`).Bind(dbx.Params{
		"user": user.Id, "subscription": second.Id,
	}).Execute(); err != nil {
		t.Fatal(err)
	}

	firstPageResponse := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions/calendar-feeds?limit=1&offset=0", "", token)
	if firstPageResponse.Code != http.StatusOK {
		t.Fatalf("list first page: %d %s", firstPageResponse.Code, firstPageResponse.Body.String())
	}
	if got := firstPageResponse.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("expected no-store list response, got %q", got)
	}
	firstPage := decodeAPISuccessDataForTest[subscriptionCalendarFeedListResponse](t, firstPageResponse.Body.Bytes()).CalendarFeeds
	if firstPage.Total != 2 || !firstPage.HasMore || len(firstPage.Items) != 1 {
		t.Fatalf("unexpected first page: %#v", firstPage)
	}
	for _, item := range firstPage.Items {
		if _, err := time.Parse(time.RFC3339, item.CreatedAt); err != nil {
			t.Fatalf("expected RFC3339 management timestamps, got %q: %v", item.CreatedAt, err)
		}
	}
	if strings.Contains(firstPageResponse.Body.String(), `"scope"`) || strings.Contains(firstPageResponse.Body.String(), `"price"`) || strings.Contains(firstPageResponse.Body.String(), `"notes"`) {
		t.Fatalf("management list leaked the full subscription DTO: %s", firstPageResponse.Body.String())
	}

	secondPage := decodeAPISuccessDataForTest[subscriptionCalendarFeedListResponse](t, serveTestRequest(
		t, app, http.MethodGet, "/api/app/subscriptions/calendar-feeds?limit=1&offset=1", "", token,
	).Body.Bytes()).CalendarFeeds
	if secondPage.Total != 2 || secondPage.HasMore || len(secondPage.Items) != 1 {
		t.Fatalf("unexpected second page: %#v", secondPage)
	}
	if firstPage.Items[0].ID <= secondPage.Items[0].ID {
		t.Fatalf("expected equal timestamps to use id DESC tie-break, first=%q second=%q", firstPage.Items[0].ID, secondPage.Items[0].ID)
	}
	if firstPage.Items[0].Subscription.ID == secondPage.Items[0].Subscription.ID {
		t.Fatalf("expected distinct subscription feeds across pages: %#v %#v", firstPage.Items, secondPage.Items)
	}
	emptyPage := decodeAPISuccessDataForTest[subscriptionCalendarFeedListResponse](t, serveTestRequest(
		t, app, http.MethodGet, "/api/app/subscriptions/calendar-feeds?limit=2&offset=99", "", token,
	).Body.Bytes()).CalendarFeeds
	if emptyPage.Total != 2 || len(emptyPage.Items) != 0 {
		t.Fatalf("expected empty page with stable total, got %#v", emptyPage)
	}

	for _, target := range []string{
		"/api/app/subscriptions/calendar-feeds?limit=51&offset=0",
		"/api/app/subscriptions/calendar-feeds?limit=2e1&offset=0",
		"/api/app/subscriptions/calendar-feeds?limit=20&limit=10&offset=0",
		"/api/app/subscriptions/calendar-feeds?limit=20&offset=0&cursor=legacy",
	} {
		if response := serveTestRequest(t, app, http.MethodGet, target, "", token); response.Code != http.StatusBadRequest {
			t.Fatalf("expected invalid list query %s to return 400, got %d", target, response.Code)
		}
	}
	if response := serveTestRequest(t, app, http.MethodGet, "/api/app/calendar-feeds?limit=20&offset=0", "", token); response.Code != http.StatusNotFound {
		t.Fatalf("expected removed mixed feed route to return 404, got %d", response.Code)
	}
	if response := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+foreign.Id+"/calendar-feed/rotate", `{}`, token); response.Code != http.StatusNotFound {
		t.Fatalf("expected foreign subscription rotate to return 404, got %d: %s", response.Code, response.Body.String())
	}
}

func TestCalendarFeedAtomicRotateAndRevokeLifecycle(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "user")
	subscription := createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name: "Fastmail", BillingCycle: "monthly", Status: "active", NextBillingDate: "2099-06-01",
	})
	createResponse := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+subscription.Id+"/calendar-feed", `{}`, token)
	created := decodeAPISuccessDataForTest[calendarFeedCreateResponse](t, createResponse.Body.Bytes()).CalendarFeed

	invalid := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+subscription.Id+"/calendar-feed/rotate", `{"token":"client"}`, token)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("expected strict rotate request, got %d: %s", invalid.Code, invalid.Body.String())
	}
	if response := serveTestRequest(t, app, http.MethodGet, calendarFeedRequestTarget(t, created.FeedURL), "", ""); response.Code != http.StatusOK {
		t.Fatalf("invalid rotate changed the old URL: %d %s", response.Code, response.Body.String())
	}

	rotateResponse := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+subscription.Id+"/calendar-feed/rotate", `{}`, token)
	if rotateResponse.Code != http.StatusOK || rotateResponse.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("rotate response: %d cache=%q body=%s", rotateResponse.Code, rotateResponse.Header().Get("Cache-Control"), rotateResponse.Body.String())
	}
	rotated := decodeAPISuccessDataForTest[calendarFeedCreateResponse](t, rotateResponse.Body.Bytes()).CalendarFeed
	if rotated.FeedURL == created.FeedURL || rotated.CreatedAt != created.CreatedAt {
		t.Fatalf("expected in-place token rotation, old=%#v new=%#v", created, rotated)
	}
	if old := serveTestRequest(t, app, http.MethodGet, calendarFeedRequestTarget(t, created.FeedURL), "", ""); old.Code != http.StatusNotFound {
		t.Fatalf("expected old URL 404 after rotate, got %d", old.Code)
	}
	if fresh := serveTestRequest(t, app, http.MethodGet, calendarFeedRequestTarget(t, rotated.FeedURL), "", ""); fresh.Code != http.StatusOK {
		t.Fatalf("expected rotated URL to remain readable, got %d: %s", fresh.Code, fresh.Body.String())
	}
	app.OnRecordUpdateExecute("calendar_feeds").BindFunc(func(*core.RecordEvent) error {
		return errors.New("calendar feed write failed")
	})
	failedRotate := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+subscription.Id+"/calendar-feed/rotate", `{}`, token)
	if failedRotate.Code != http.StatusInternalServerError {
		t.Fatalf("expected failed rotation to return 500, got %d: %s", failedRotate.Code, failedRotate.Body.String())
	}
	if current := serveTestRequest(t, app, http.MethodGet, calendarFeedRequestTarget(t, rotated.FeedURL), "", ""); current.Code != http.StatusOK {
		t.Fatalf("failed rotate invalidated the current URL: %d %s", current.Code, current.Body.String())
	}

	revoke := serveTestRequest(t, app, http.MethodDelete, "/api/app/subscriptions/"+subscription.Id+"/calendar-feed", "", token)
	if revoke.Code != http.StatusOK || revoke.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("revoke response: %d cache=%q body=%s", revoke.Code, revoke.Header().Get("Cache-Control"), revoke.Body.String())
	}
	if missing := serveTestRequest(t, app, http.MethodDelete, "/api/app/subscriptions/"+subscription.Id+"/calendar-feed", "", token); missing.Code != http.StatusNotFound {
		t.Fatalf("expected repeated revoke to return 404, got %d: %s", missing.Code, missing.Body.String())
	}
}

func TestSubscriptionDeleteRevokesOnlyTargetCalendarFeed(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "user")
	otherUser, otherToken := createRouteTestUser(t, app, "admin")
	target := createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name: "Delete with feed", BillingCycle: "monthly", Status: "active", NextBillingDate: "2099-06-01",
	})
	preserved := createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name: "Preserved same owner", BillingCycle: "monthly", Status: "active", NextBillingDate: "2099-06-02",
	})
	foreign := createCalendarFeedTestSubscription(t, app, otherUser.Id, calendarFeedTestSubscription{
		Name: "Preserved other owner", BillingCycle: "monthly", Status: "active", NextBillingDate: "2099-06-03",
	})
	for _, request := range []struct {
		target string
		token  string
	}{
		{target: "/api/app/subscriptions/" + target.Id + "/calendar-feed", token: token},
		{target: "/api/app/subscriptions/" + preserved.Id + "/calendar-feed", token: token},
		{target: "/api/app/subscriptions/" + foreign.Id + "/calendar-feed", token: otherToken},
	} {
		if response := serveTestRequest(t, app, http.MethodPost, request.target, `{}`, request.token); response.Code != http.StatusOK {
			t.Fatalf("create %s: %d %s", request.target, response.Code, response.Body.String())
		}
	}
	createdResponse := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions/"+target.Id+"/calendar-feed", "", token)
	if createdResponse.Code != http.StatusOK {
		t.Fatalf("load target feed: %d %s", createdResponse.Code, createdResponse.Body.String())
	}
	created := decodeAPISuccessDataForTest[calendarFeedStatusResponse](t, createdResponse.Body.Bytes()).CalendarFeed

	if response := serveTestRequest(t, app, http.MethodDelete, "/api/app/subscriptions/"+target.Id, "", token); response.Code != http.StatusOK {
		t.Fatalf("delete subscription: %d %s", response.Code, response.Body.String())
	}
	if _, err := app.FindRecordById("subscriptions", target.Id); err == nil || !errorsIsNoRows(err) {
		t.Fatalf("expected target subscription to be deleted, got %v", err)
	}
	if records, err := app.FindRecordsByFilter("calendar_feeds", "user = {:user} && subscriptionId = {:subscription}", "", 10, 0, dbx.Params{
		"user": user.Id, "subscription": target.Id,
	}); err != nil || len(records) != 0 {
		t.Fatalf("expected subscription delete to remove its feed, records=%d err=%v", len(records), err)
	}
	if response := serveTestRequest(t, app, http.MethodGet, calendarFeedRequestTarget(t, created.FeedURL), "", ""); response.Code != http.StatusNotFound {
		t.Fatalf("expected deleted subscription feed URL to return 404, got %d", response.Code)
	}
	for _, item := range []struct {
		userID         string
		subscriptionID string
	}{
		{userID: user.Id, subscriptionID: preserved.Id},
		{userID: otherUser.Id, subscriptionID: foreign.Id},
	} {
		record, err := findSubscriptionCalendarFeedForUser(app, item.userID, item.subscriptionID)
		if err != nil || record == nil {
			t.Fatalf("expected unrelated feed to remain, user=%q subscription=%q record=%v err=%v", item.userID, item.subscriptionID, record, err)
		}
	}
}

func TestDeleteOrphanSubscriptionCalendarFeedsRepairsHistoricalRows(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "user")
	orphanSubscription := createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name: "Historical orphan", BillingCycle: "monthly", Status: "active", NextBillingDate: "2099-06-01",
	})
	if response := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+orphanSubscription.Id+"/calendar-feed", `{}`, token); response.Code != http.StatusOK {
		t.Fatalf("create orphan fixture feed: %d %s", response.Code, response.Body.String())
	}
	if _, err := app.DB().NewQuery("DELETE FROM subscriptions WHERE id = {:id}").Bind(dbx.Params{"id": orphanSubscription.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	if err := deleteOrphanSubscriptionCalendarFeeds(app); err != nil {
		t.Fatal(err)
	}
	if records, err := app.FindRecordsByFilter("calendar_feeds", "user = {:user} && subscriptionId = {:subscription}", "", 10, 0, dbx.Params{
		"user": user.Id, "subscription": orphanSubscription.Id,
	}); err != nil || len(records) != 0 {
		t.Fatalf("expected data repair to remove orphan feed, records=%d err=%v", len(records), err)
	}
}

func TestSubscriptionDeleteRollsBackWhenCalendarFeedRevocationFails(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user := createSchemaTestUser(t, app, "calendar-feed-delete-rollback@example.com")
	subscription := createCalendarFeedTestSubscription(t, app, user.Id, calendarFeedTestSubscription{
		Name: "Rollback feed", BillingCycle: "monthly", Status: "active", NextBillingDate: "2099-06-01",
	})
	feed, err := ensureSubscriptionCalendarFeed(app, user.Id, subscription.Id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery(`CREATE TRIGGER fail_calendar_feed_delete
		BEFORE DELETE ON calendar_feeds
		BEGIN
			SELECT RAISE(ABORT, 'injected calendar feed delete failure');
		END`).Execute(); err != nil {
		t.Fatal(err)
	}

	if err := app.Delete(subscription); err == nil || !strings.Contains(err.Error(), "injected calendar feed delete failure") {
		t.Fatalf("expected injected calendar feed delete failure, got %v", err)
	}
	if _, err := app.FindRecordById("subscriptions", subscription.Id); err != nil {
		t.Fatalf("subscription delete must roll back with feed revocation: %v", err)
	}
	if _, err := app.FindRecordById("calendar_feeds", feed.Id); err != nil {
		t.Fatalf("calendar feed must remain when its revocation fails: %v", err)
	}
}
