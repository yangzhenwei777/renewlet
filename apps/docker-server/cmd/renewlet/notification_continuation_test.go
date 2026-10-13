package main

import (
	"testing"
	"time"
)

func TestNotificationCompletedWindowAdvancesStrictly(t *testing.T) {
	now := time.Date(2026, 9, 8, 8, 0, 0, 0, time.UTC)
	if got := getNextLocalScheduleOccurrence(now, "UTC", "08:00", true).ScheduledInstantUTC; got != "2026-09-08T08:00:00Z" {
		t.Fatal(got)
	}
	if got := nextDailyNotificationDueAt(now, "UTC", "08:00", true); got != "2026-09-09T08:00:00Z" {
		t.Fatal(got)
	}
	settings := defaultAppSettings()
	settings.Timezone = "UTC"
	settings.NotificationTimeLocal = "08:00"
	subscriptions := []notificationSubscription{{Status: "active", NextBillingDate: "2026-09-11", ReminderDays: 3, RepeatReminderEnabled: true, RepeatReminderInterval: "1h", RepeatReminderWindow: "full"}}
	now = now.Add(time.Hour)
	if got := nextRepeatNotificationDueAt(now, settings, subscriptions, false); got != "2026-09-08T09:00:00Z" {
		t.Fatal(got)
	}
	if got := nextRepeatNotificationDueAt(now, settings, subscriptions, true); got != "2026-09-08T10:00:00Z" {
		t.Fatal(got)
	}
}

func TestNotificationExhaustedSendingFencesLateResult(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "exhausted")
	schedule := getLocalScheduleDecision(time.Date(2026, 9, 8, 8, 0, 0, 0, time.UTC), "UTC", "08:00", 2, false)
	job, _, err := createNotificationJob(app, user.Id, schedule, notificationStatusSending, 3)
	if err != nil {
		t.Fatal(err)
	}
	if settled, err := failExhaustedNotificationJob(app, job); err != nil || !settled {
		t.Fatalf("settled=%v err=%v", settled, err)
	}
	if settled, err := failExhaustedNotificationJob(app, job); err != nil || settled {
		t.Fatalf("stale settled=%v err=%v", settled, err)
	}
	if finalized, err := finalizeNotificationJob(app, job, user.Id, schedule, notificationStatusSent, "", largeNotificationJobResult(1)); err != nil || finalized {
		t.Fatalf("late finalized=%v err=%v", finalized, err)
	}
	current, err := app.FindRecordById("notification_jobs", job.Id)
	if err != nil {
		t.Fatal(err)
	}
	if current.GetString("status") != notificationStatusFailed || current.GetInt("attempts") != 3 || current.GetString("lastError") != "max_retries_reached" {
		t.Fatal(current)
	}
}
