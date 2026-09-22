package main

import (
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func TestAdminUsersRouteReturnsManagementContract(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, token := createRouteTestUser(t, app, "admin")

	res := serveTestRequest(t, app, http.MethodGet, "/api/app/admin/users", "", token)
	body := res.Body.String()
	if res.Code != http.StatusOK {
		t.Fatalf("expected users 200, got %d: %s", res.Code, body)
	}
	for _, expected := range []string{`"users"`, `"role":"admin"`, `"createdAt"`, `"updatedAt"`} {
		if !strings.Contains(body, expected) {
			t.Fatalf("missing %s in response: %s", expected, body)
		}
	}
}

func TestAdminPatchUserRejectsStrictJSONViolations(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, token := createRouteTestUser(t, app, "admin")
	editable, _ := createRouteTestUser(t, app, "user")

	cases := []struct {
		name string
		body string
	}{
		{name: "unknown field", body: `{"banned":false,"extra":true}`},
		{name: "empty object", body: `{}`},
		{name: "invalid role", body: `{"role":"owner"}`},
		{name: "short password", body: `{"newPassword":"short"}`},
		{name: "multiple json values", body: `{"banned":false} {}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := serveTestRequest(t, app, http.MethodPatch, "/api/app/admin/users/"+editable.Id, tc.body, token)
			if res.Code != http.StatusBadRequest {
				t.Fatalf("expected admin patch strict JSON violation to return 400, got %d: %s", res.Code, res.Body.String())
			}
		})
	}
}

func TestAdminPatchUserPasswordResetBoundary(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	admin, token := createRouteTestUser(t, app, "admin")
	editable, _ := createRouteTestUser(t, app, "user")

	res := serveTestRequest(t, app, http.MethodPatch, "/api/app/admin/users/"+editable.Id, `{"newPassword":"newpassword123"}`, token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected admin to reset another user's password, got %d: %s", res.Code, res.Body.String())
	}
	reloadedEditable, err := app.FindRecordById("users", editable.Id)
	if err != nil {
		t.Fatal(err)
	}
	if !reloadedEditable.ValidatePassword("newpassword123") {
		t.Fatal("expected admin patch to update another user's password")
	}

	res = serveTestRequest(t, app, http.MethodPatch, "/api/app/admin/users/"+admin.Id, `{"newPassword":"selfpassword123"}`, token)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("expected self password reset through admin patch to return 400, got %d: %s", res.Code, res.Body.String())
	}
	reloadedAdmin, err := app.FindRecordById("users", admin.Id)
	if err != nil {
		t.Fatal(err)
	}
	if !reloadedAdmin.ValidatePassword("password123") {
		t.Fatal("expected rejected self reset to keep the old password")
	}
	if reloadedAdmin.ValidatePassword("selfpassword123") {
		t.Fatal("expected rejected self reset not to store the new password")
	}
}

func TestAccountPasswordRouteRequiresCurrentPassword(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "user")

	res := serveTestRequest(t, app, http.MethodPut, "/api/app/account/password", `{"currentPassword":"wrongpassword","newPassword":"newpassword123"}`, token)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("expected wrong current password to return 400, got %d: %s", res.Code, res.Body.String())
	}
	reloadedUser, err := app.FindRecordById("users", user.Id)
	if err != nil {
		t.Fatal(err)
	}
	if !reloadedUser.ValidatePassword("password123") {
		t.Fatal("expected wrong current password to keep the old password")
	}
}

func TestBannedUserCannotRefreshOrUseExistingPocketBaseToken(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUserWithPocketBaseToken(t, app, "user")
	subscriptions, err := app.FindCollectionByNameOrId("subscriptions")
	if err != nil {
		t.Fatal(err)
	}
	subscription := core.NewRecord(subscriptions)
	subscription.Set("user", user.Id)
	subscription.Set("name", "Banned token test")
	subscription.Set("price", "12")
	subscription.Set("currency", "USD")
	subscription.Set("billingCycle", "monthly")
	subscription.Set("category", "Software")
	subscription.Set("status", "active")
	subscription.Set("startDate", "2026-06-04")
	subscription.Set("nextBillingDate", "2026-07-04")
	if err := app.Save(subscription); err != nil {
		t.Fatal(err)
	}
	user.Set("banned", true)
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}

	refreshRes := servePocketBaseTestRequest(t, app, http.MethodPost, "/api/collections/users/auth-refresh", `{}`, token)
	if refreshRes.Code != http.StatusUnauthorized {
		t.Fatalf("expected banned auth refresh to return 401, got %d: %s", refreshRes.Code, refreshRes.Body.String())
	}

	listRes := servePocketBaseTestRequest(t, app, http.MethodGet, "/api/collections/subscriptions/records", "", token)
	if listRes.Code != http.StatusOK {
		t.Fatalf("expected banned collection list to preserve PocketBase list status, got %d: %s", listRes.Code, listRes.Body.String())
	}
	if strings.Contains(listRes.Body.String(), subscription.Id) {
		t.Fatalf("expected banned collection list not to return private record, got %s", listRes.Body.String())
	}
}

func TestDeletedUserTokenCannotUseCustomAuthenticatedRoutes(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteTestUser(t, app, "user")
	if err := app.Delete(user); err != nil {
		t.Fatal(err)
	}

	res := serveTestRequest(t, app, http.MethodGet, "/api/app/notifications/history?status=all&limit=5", "", token)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("expected deleted user token to return 401, got %d: %s", res.Code, res.Body.String())
	}
}

func TestNotificationHistoryRouteSortsByCreatedField(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	_, token := createRouteTestUser(t, app, "user")

	res := serveTestRequest(t, app, http.MethodGet, "/api/app/notifications/history?status=all&limit=5", "", token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected notification history 200, got %d: %s", res.Code, res.Body.String())
	}
}
