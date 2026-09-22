package main

// 外部 cron route 测试保护 CRON_SECRET Bearer 边界；dryRun 不能落库，且该入口不依赖登录态。

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func createNotificationCronRouteTestSettings(t *testing.T, app core.App, user *core.Record, settings appSettings) *core.Record {
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

func refreshNotificationSchedulerForTest(t *testing.T, app core.App, userID string, now time.Time) {
	t.Helper()
	// due-index 不再全量扫 settings；测试用 fake now 建立同一时间轴，才能覆盖真实 cron 热路径。
	if _, err := refreshSubscriptionSchedulerStateWithOptions(app, userID, subscriptionSchedulerRefreshOptions{Now: now, ResetAutoRenewCheck: true}); err != nil {
		t.Fatal(err)
	}
}

func TestNotificationCronRouteRequiresConfiguredSecret(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CRON_SECRET", "")

	res := serveTestRequest(t, app, http.MethodGet, "/api/cron/notifications", "", "Bearer cron-secret")
	if res.Code != http.StatusInternalServerError {
		t.Fatalf("expected missing cron secret to return 500, got %d: %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"code":"CRON_SECRET_MISSING"`) {
		t.Fatalf("expected missing cron secret code, got %s", res.Body.String())
	}
}

func TestNotificationCronRouteRejectsInvalidAuthorization(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CRON_SECRET", "cron-secret")

	cases := []struct {
		name   string
		target string
		header string
	}{
		{name: "missing authorization", target: "/api/cron/notifications"},
		{name: "wrong bearer token", target: "/api/cron/notifications", header: "Bearer wrong-secret"},
		{name: "empty bearer token", target: "/api/cron/notifications", header: "Bearer "},
		{name: "query secret is ignored", target: "/api/cron/notifications?secret=cron-secret"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := serveTestRequest(t, app, http.MethodGet, tc.target, "", tc.header)
			if res.Code != http.StatusUnauthorized {
				t.Fatalf("expected unauthorized cron request to return 401, got %d: %s", res.Code, res.Body.String())
			}
		})
	}
}

func TestNotificationCronRouteRunsDryRunWithoutCreatingJobs(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CRON_SECRET", "cron-secret")
	t.Setenv("NOTIFICATION_SCHEDULER_ENABLED", "false")
	user, _ := createRouteTestUser(t, app, "user")
	settings := defaultAppSettings()
	settings.EnabledChannels = []string{"webhook"}
	createNotificationCronRouteTestSettings(t, app, user, settings)

	res := serveTestRequest(t, app, http.MethodGet, "/api/cron/notifications?dryRun=1&force=1", "", "Bearer cron-secret")
	if res.Code != http.StatusOK {
		t.Fatalf("expected cron dry run 200, got %d: %s", res.Code, res.Body.String())
	}
	body := decodeAPISuccessDataForTest[notificationCronResult](t, res.Body.Bytes())
	if !body.DryRun || !body.Force || body.Processed != 1 || body.Sent != 1 {
		t.Fatalf("unexpected cron dry run response: %#v", body)
	}
	jobs, err := app.FindAllRecords("notification_jobs")
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 0 {
		t.Fatalf("expected dry run not to create notification jobs, got %d", len(jobs))
	}
}
