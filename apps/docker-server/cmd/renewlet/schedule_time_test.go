package main

import (
	"testing"
	"time"
)

func TestCloudBackupScheduleMatchesReminderTimeFixtures(t *testing.T) {
	for _, fixture := range readNotificationScheduleFixtures(t) {
		if fixture.Expected.NextDailyInstantUTC == "" || !fixture.Expected.Due {
			continue
		}
		t.Run(fixture.Name, func(t *testing.T) {
			now, err := time.Parse(time.RFC3339, fixture.NowUTC)
			if err != nil {
				t.Fatal(err)
			}
			policy := cloudBackupPolicy{ScheduleEnabled: true, ScheduleFrequency: "daily", ScheduleTime: fixture.Settings.NotificationTimeLocal}
			got := latestCloudBackupScheduledInstant(now, fixture.Settings.Timezone, policy)
			if got.UTC().Format(time.RFC3339) != fixture.Expected.ScheduledInstantUTC {
				t.Fatalf("backup instant=%s want=%s", got, fixture.Expected.ScheduledInstantUTC)
			}
		})
	}
}

func TestScheduleInstantRejectsInvalidWallTime(t *testing.T) {
	for _, value := range []string{"", "2:30", "24:00", "02:99"} {
		if _, err := getScheduleInstant("2026-03-08", value, "America/New_York"); err == nil {
			t.Fatalf("accepted invalid time %q", value)
		}
	}
}

func TestNotificationJobKeyPreservesSharedWallTime(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "schedule-key")
	for _, fixture := range readNotificationScheduleFixtures(t) {
		if fixture.Expected.NextDailyInstantUTC == "" || !fixture.Expected.Due {
			continue
		}
		t.Run(fixture.Name, func(t *testing.T) {
			now, err := time.Parse(time.RFC3339, fixture.NowUTC)
			if err != nil {
				t.Fatal(err)
			}
			schedule := getLocalScheduleDecision(now, fixture.Settings.Timezone, fixture.Settings.NotificationTimeLocal, 2, false)
			if _, created, err := createNotificationJob(app, user.Id, schedule, notificationStatusSkipped, 1); err != nil || !created {
				t.Fatalf("create job: created=%v err=%v", created, err)
			}
			persisted, err := getNotificationJob(app, user.Id, fixture.Expected.ScheduledLocalDate, fixture.Expected.ScheduledLocalTime, fixture.Expected.TimeZone)
			if err != nil {
				t.Fatal(err)
			}
			if got := persisted.GetString("scheduledInstantUtc"); got != fixture.Expected.ScheduledInstantUTC {
				t.Fatalf("stored instant=%s want=%s", got, fixture.Expected.ScheduledInstantUTC)
			}
		})
	}
}
