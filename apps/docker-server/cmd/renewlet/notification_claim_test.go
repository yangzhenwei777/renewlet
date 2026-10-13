package main

import (
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type notificationClaimReadApp struct {
	core.App
	afterRead func(*core.Record)
}

func (app *notificationClaimReadApp) FindFirstRecordByFilter(collection any, filter string, params ...dbx.Params) (*core.Record, error) {
	record, err := app.App.FindFirstRecordByFilter(collection, filter, params...)
	// 在真实快照已读取、事务抢占尚未开始的边界插入另一执行者；事务内仍使用原生数据库。
	if collection == "notification_jobs" && err == nil {
		app.afterRead(record)
	}
	return record, err
}

func TestNotificationCronLostClaimPreservesDueState(t *testing.T) {
	for _, phase := range []string{"claim", "finalize", "skip"} {
		t.Run(phase, func(t *testing.T) {
			withSafeOutboundResolver(t)
			app := newSchemaTestApp(t)
			if err := ensureSchema(app); err != nil {
				t.Fatal(err)
			}
			registerRecordHooks(app)
			user, _ := createRouteTestUser(t, app, "claim-gate")
			settings := defaultAppSettings()
			settings.Timezone = "UTC"
			settings.NotificationTimeLocal = "08:00"
			settings.EnabledChannels = []string{"webhook"}
			settings.WebhookURL = "https://example.com/notification"
			if phase == "skip" {
				settings.EnabledChannels = []string{}
			}
			createNotificationCronRouteTestSettings(t, app, user, settings)
			createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"autoRenew": false, "nextBillingDate": "2026-09-11", "reminderDays": 3})
			now := time.Date(2026, 9, 8, 8, 0, 0, 0, time.UTC)
			refreshNotificationSchedulerForTest(t, app, user.Id, now)
			before, err := getSubscriptionSchedulerState(app, user.Id)
			if err != nil {
				t.Fatal(err)
			}
			schedule := getLocalScheduleDecision(now, "UTC", "08:00", 2, false)
			job, _, err := createNotificationJob(app, user.Id, schedule, notificationStatusSending, 1)
			if err != nil {
				t.Fatal(err)
			}
			previous := largeNotificationJobResult(1)
			previous.Channels = jobChannels{Attempted: []string{"webhook"}, Failed: []channelFailure{{Channel: "webhook", Error: "fixture failure"}}}
			if finalized, err := finalizeNotificationJob(app, job, user.Id, schedule, notificationStatusFailed, "fixture failure", previous); err != nil || !finalized {
				t.Fatalf("initialize failed job: %v %v", finalized, err)
			}
			steal := func(record *core.Record) {
				if claimed, err := markNotificationJobSending(app, record, record.GetInt("attempts")+1); err != nil || claimed == nil {
					t.Fatalf("competitor did not claim: %v", err)
				}
			}
			calls := 0
			restore := withNotificationHTTPClient(t, serverChanRoundTripFunc(func(request *http.Request) (*http.Response, error) {
				calls++
				current, err := app.FindRecordById("notification_jobs", job.Id)
				if err != nil {
					t.Fatal(err)
				}
				steal(current)
				return serverChanTestResponse(http.StatusOK, `{}`), nil
			}))
			defer restore()
			var executor core.App = app
			if phase != "finalize" {
				executor = &notificationClaimReadApp{App: app, afterRead: steal}
			}
			row, err := notificationSettingsRecordForUser(app, user.Id)
			if err != nil {
				t.Fatal(err)
			}
			result, err := processNotificationCronUser(executor, notificationCronOptions{Now: now, WindowMinutes: 2, MaxRetries: 3, StaleSendingMinutes: 15}, row)
			if err != nil || result.Reason != "claim_lost" {
				t.Fatalf("lost claim: %+v %v", result, err)
			}
			expectedCalls := 0
			if phase == "finalize" {
				expectedCalls = 1
			}
			if calls != expectedCalls {
				t.Fatalf("external calls=%d expected=%d", calls, expectedCalls)
			}
			after, err := getSubscriptionSchedulerState(app, user.Id)
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Fatalf("lost claim advanced due state: %+v %+v %v", before, after, err)
			}
		})
	}
}

func TestNotificationClaimFencesConcurrentExecutors(t *testing.T) {
	for _, status := range []string{notificationStatusFailed, notificationStatusSending} {
		t.Run(status, func(t *testing.T) {
			app := newSchemaTestApp(t)
			if err := ensureSchema(app); err != nil {
				t.Fatal(err)
			}
			user, _ := createRouteTestUser(t, app, "claim-owner")
			previous := largeNotificationJobResult(100)
			previous.Channels = jobChannels{Attempted: []string{"telegram", "webhook"}, Succeeded: []string{"telegram"}, Failed: []channelFailure{{Channel: "webhook", Error: "old failure"}}}
			schedule := localScheduleDecision{localScheduleOccurrence: previous.Schedule}
			job, _, err := createNotificationJob(app, user.Id, schedule, notificationStatusSending, 1)
			if err != nil {
				t.Fatal(err)
			}
			if finalized, err := finalizeNotificationJob(app, job, user.Id, schedule, notificationStatusFailed, "old failure", previous); err != nil || !finalized {
				t.Fatalf("initialize result: %v %v", finalized, err)
			}
			if _, err := app.DB().NewQuery("UPDATE notification_jobs SET status = {:status}, updated = '2026-01-01 00:00:00.000Z' WHERE id = {:id}").Bind(dbx.Params{"status": status, "id": job.Id}).Execute(); err != nil {
				t.Fatal(err)
			}
			original, err := app.FindRecordById("notification_jobs", job.Id)
			if err != nil {
				t.Fatal(err)
			}
			type claimResult struct {
				job *core.Record
				err error
			}
			const contenders = 8
			start := make(chan struct{})
			claims := make(chan claimResult, contenders)
			// 同一真实快照同时竞争，避免串行读取掩盖无条件Save导致的重复接管。
			for range contenders {
				snapshot := original.Clone()
				go func() {
					<-start
					claimed, err := markNotificationJobSending(app, snapshot, 2)
					claims <- claimResult{claimed, err}
				}()
			}
			close(start)
			var winner *core.Record
			for range contenders {
				claim := <-claims
				if claim.err != nil {
					t.Fatal(claim.err)
				}
				if claim.job != nil {
					if winner != nil {
						t.Fatal("multiple executors claimed one job")
					}
					winner = claim.job
				}
			}
			if winner == nil {
				t.Fatal("no executor claimed the job")
			}
			before, err := loadNotificationHistoryJobs(app, user.Id, "all", 20, 0)
			if err != nil {
				t.Fatal(err)
			}
			if finalized, err := finalizeNotificationJob(app, original, user.Id, schedule, notificationStatusSent, "", largeNotificationJobResult(5000)); err != nil || finalized {
				t.Fatalf("old claim finalized: %v %v", finalized, err)
			}
			after, err := loadNotificationHistoryJobs(app, user.Id, "all", 20, 0)
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Fatalf("old claim changed message or channels: %v", err)
			}
			replacement, err := markNotificationJobSending(app, winner, 3)
			if err != nil || replacement == nil {
				t.Fatalf("replace claim: %v", err)
			}
			completed := largeNotificationJobResult(1000)
			completed.Channels = jobChannels{Attempted: []string{"telegram", "webhook"}, Succeeded: []string{"telegram", "webhook"}, Failed: []channelFailure{}}
			if finalized, err := finalizeNotificationJob(app, replacement, user.Id, schedule, notificationStatusSent, "", completed); err != nil || !finalized {
				t.Fatalf("winning claim did not finalize: %v %v", finalized, err)
			}
			before, err = loadNotificationHistoryJobs(app, user.Id, "all", 20, 0)
			if err != nil || len(before) != 1 || !reflect.DeepEqual(assertNormalizedCronResult(t, before[0]), completed) {
				t.Fatalf("winning snapshot differs: %v", err)
			}
			if finalized, err := finalizeNotificationJob(app, winner, user.Id, schedule, notificationStatusFailed, "late failure", previous); err != nil || finalized {
				t.Fatalf("superseded claim finalized: %v %v", finalized, err)
			}
			if finalized, err := finalizeNotificationJob(app, nil, user.Id, schedule, notificationStatusSkipped, "", previous); err != nil || finalized {
				t.Fatalf("concurrent creator finalized: %v %v", finalized, err)
			}
			after, err = loadNotificationHistoryJobs(app, user.Id, "all", 20, 0)
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Fatalf("late executor changed completed history: %v", err)
			}
		})
	}
}

func TestNotificationClaimIncludesPersistedUpdateTime(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user, _ := createRouteTestUser(t, app, "claim-time")
	result := largeNotificationJobResult(1)
	schedule := localScheduleDecision{localScheduleOccurrence: result.Schedule}
	job, _, err := createNotificationJob(app, user.Id, schedule, notificationStatusFailed, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery("UPDATE notification_jobs SET updated = '2026-01-01 00:00:00.000Z' WHERE id = {:id}").Bind(dbx.Params{"id": job.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	if claimed, err := markNotificationJobSending(app, job, 2); err != nil || claimed != nil {
		t.Fatalf("outdated timestamp claimed: %v %v", claimed, err)
	}
	if finalized, err := finalizeNotificationJob(app, job, user.Id, schedule, notificationStatusSent, "", result); err != nil || finalized {
		t.Fatalf("outdated timestamp finalized: %v %v", finalized, err)
	}
}
