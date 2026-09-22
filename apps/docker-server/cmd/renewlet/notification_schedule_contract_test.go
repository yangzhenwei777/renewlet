package main

// 通知调度 fixture 由 shared 提供，Go 与 Cloudflare Worker 必须用同一组样例锁住窗口和 repeat 语义。

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

type notificationScheduleFixture struct {
	Name          string                                 `json:"name"`
	NowUTC        string                                 `json:"nowUtc"`
	Settings      notificationScheduleFixtureSettings    `json:"settings"`
	Subscriptions []notificationScheduleFixtureSub       `json:"subscriptions"`
	WindowMinutes int                                    `json:"windowMinutes"`
	Force         bool                                   `json:"force"`
	Expected      notificationScheduleFixtureExpectation `json:"expected"`
}

type notificationScheduleFixtureSettings struct {
	Timezone                 string `json:"timezone"`
	NotificationTimeLocal    string `json:"notificationTimeLocal"`
	NotificationReminderDays int    `json:"notificationReminderDays"`
}

type notificationScheduleFixtureSub struct {
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	Price                  string `json:"price"`
	Currency               string `json:"currency"`
	Status                 string `json:"status"`
	BillingCycle           string `json:"billingCycle"`
	OneTimeTermCount       int    `json:"oneTimeTermCount,omitempty"`
	OneTimeTermUnit        string `json:"oneTimeTermUnit,omitempty"`
	NextBillingDate        string `json:"nextBillingDate"`
	TrialEndDate           string `json:"trialEndDate,omitempty"`
	ReminderDays           int    `json:"reminderDays"`
	RepeatReminderEnabled  bool   `json:"repeatReminderEnabled"`
	RepeatReminderInterval string `json:"repeatReminderInterval"`
	RepeatReminderWindow   string `json:"repeatReminderWindow"`
}

type notificationScheduleFixtureExpectation struct {
	Due                 bool                    `json:"due"`
	Reason              string                  `json:"reason"`
	ScheduledLocalDate  string                  `json:"scheduledLocalDate"`
	ScheduledLocalTime  string                  `json:"scheduledLocalTime"`
	TimeZone            string                  `json:"timeZone"`
	ScheduledInstantUTC string                  `json:"scheduledInstantUtc"`
	ItemTypes           []string                `json:"itemTypes"`
	RepeatReminder      *repeatReminderSnapshot `json:"repeatReminder"`
}

func TestNotificationScheduleMatchesSharedFixtures(t *testing.T) {
	fixtures := readNotificationScheduleFixtures(t)
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			now, err := time.Parse(time.RFC3339, fixture.NowUTC)
			if err != nil {
				t.Fatalf("parse nowUtc: %v", err)
			}
			settings := defaultAppSettings()
			settings.Timezone = fixture.Settings.Timezone
			settings.NotificationTimeLocal = fixture.Settings.NotificationTimeLocal
			settings.NotificationReminderDays = fixture.Settings.NotificationReminderDays
			subscriptions := notificationScheduleFixtureSubscriptions(fixture.Subscriptions)

			decision := getNotificationScheduleDecision(now, settings, subscriptions, fixture.WindowMinutes, fixture.Force)
			if decision.Due != fixture.Expected.Due {
				t.Fatalf("due = %v, want %v; reason=%s", decision.Due, fixture.Expected.Due, decision.Reason)
			}
			if !fixture.Expected.Due {
				return
			}
			if decision.Reason != fixture.Expected.Reason {
				t.Fatalf("reason = %q, want %q", decision.Reason, fixture.Expected.Reason)
			}
			if decision.ScheduledLocalDate != fixture.Expected.ScheduledLocalDate ||
				decision.ScheduledLocalTime != fixture.Expected.ScheduledLocalTime ||
				decision.TimeZone != fixture.Expected.TimeZone ||
				decision.ScheduledInstantUTC != fixture.Expected.ScheduledInstantUTC {
				t.Fatalf("schedule = %#v, want date=%s time=%s tz=%s instant=%s", decision.localScheduleOccurrence, fixture.Expected.ScheduledLocalDate, fixture.Expected.ScheduledLocalTime, fixture.Expected.TimeZone, fixture.Expected.ScheduledInstantUTC)
			}
			message := buildDueNotificationForSchedule(decision.localScheduleOccurrence, now, settings, subscriptions, true, accountContentLocale(settings))
			gotTypes := make([]string, 0, len(message.Items))
			for _, item := range message.Items {
				gotTypes = append(gotTypes, item.Type)
				if fixture.Expected.RepeatReminder != nil {
					if item.RepeatReminder == nil || *item.RepeatReminder != *fixture.Expected.RepeatReminder {
						t.Fatalf("repeat reminder = %#v, want %#v", item.RepeatReminder, fixture.Expected.RepeatReminder)
					}
				}
			}
			if len(gotTypes) != len(fixture.Expected.ItemTypes) {
				t.Fatalf("item types = %#v, want %#v", gotTypes, fixture.Expected.ItemTypes)
			}
			for i := range gotTypes {
				if gotTypes[i] != fixture.Expected.ItemTypes[i] {
					t.Fatalf("item types = %#v, want %#v", gotTypes, fixture.Expected.ItemTypes)
				}
			}
		})
	}
}

func readNotificationScheduleFixtures(t *testing.T) []notificationScheduleFixture {
	t.Helper()
	data, err := os.ReadFile("../../../../packages/shared/src/contract-fixtures/notification-schedule-fixtures.json")
	if err != nil {
		t.Fatalf("read shared notification fixtures: %v", err)
	}
	var fixtures []notificationScheduleFixture
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatalf("decode shared notification fixtures: %v", err)
	}
	return fixtures
}

func notificationScheduleFixtureSubscriptions(inputs []notificationScheduleFixtureSub) []notificationSubscription {
	out := make([]notificationSubscription, 0, len(inputs))
	for _, input := range inputs {
		out = append(out, notificationSubscription{
			ID:                     input.ID,
			Name:                   input.Name,
			Price:                  input.Price,
			Currency:               input.Currency,
			Status:                 input.Status,
			BillingCycle:           input.BillingCycle,
			OneTimeTermCount:       input.OneTimeTermCount,
			OneTimeTermUnit:        input.OneTimeTermUnit,
			NextBillingDate:        input.NextBillingDate,
			TrialEndDate:           input.TrialEndDate,
			ReminderDays:           input.ReminderDays,
			RepeatReminderEnabled:  input.RepeatReminderEnabled,
			RepeatReminderInterval: input.RepeatReminderInterval,
			RepeatReminderWindow:   input.RepeatReminderWindow,
		})
	}
	return out
}
