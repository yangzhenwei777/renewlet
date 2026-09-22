package main

// Schema migration 测试保护启动热路径：collection schema 可以每次轻量收敛，
// 历史数据修复必须通过内部账本做到失败可重试、成功不重复扫全库。

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

func TestEnsureSchemaNoopDoesNotResaveCollections(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	updates := 0
	app.OnCollectionAfterUpdateSuccess().BindFunc(func(e *core.CollectionEvent) error {
		updates++
		return e.Next()
	})

	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	if updates != 0 {
		t.Fatalf("second ensureSchema saved %d collections, want 0", updates)
	}
}

func TestSubscriptionDerivedSchemaRejectsWrongIndexDirection(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery("DROP INDEX idx_subscription_list_index_user_order").Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery(`CREATE INDEX idx_subscription_list_index_user_order
		ON subscription_list_index (user_id, created_at, subscription_id)`).Execute(); err != nil {
		t.Fatal(err)
	}

	current, err := subscriptionDerivedSchemaCurrent(app)
	if err != nil {
		t.Fatal(err)
	}
	if current {
		t.Fatal("ASC list index must not satisfy the DESC derived schema signature")
	}
}

func TestSubscriptionDerivedSchemaRejectsMissingStatsChecks(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery("DROP TABLE subscription_user_stats").Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery(`CREATE TABLE subscription_user_stats (
		user_id TEXT PRIMARY KEY,
		total_count INTEGER NOT NULL DEFAULT 0,
		trial_count INTEGER NOT NULL DEFAULT 0,
		active_count INTEGER NOT NULL DEFAULT 0,
		expired_count INTEGER NOT NULL DEFAULT 0,
		paused_count INTEGER NOT NULL DEFAULT 0,
		cancelled_count INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL DEFAULT ''
	)`).Execute(); err != nil {
		t.Fatal(err)
	}

	current, err := subscriptionDerivedSchemaCurrent(app)
	if err != nil {
		t.Fatal(err)
	}
	if current {
		t.Fatal("stats table without non-negative and status-sum checks must be rebuilt")
	}
}

func TestEnsureSchemaUpgradesHistoricalPaymentTypesAndRebuildsDerivedState(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user := createSchemaTestUser(t, app, "schema-payment-type-upgrade@example.com")
	auto := createSchemaTestSubscriptionNoValidate(t, app, user.Id, map[string]interface{}{
		"name": "Historical Auto Plan", "price": "12", "autoRenew": true,
		"startDate": "2026-07-27", "nextBillingDate": "2026-08-27",
	})
	manual := createSchemaTestSubscriptionNoValidate(t, app, user.Id, map[string]interface{}{
		"name": "Historical Manual Plan", "price": "30", "autoRenew": false,
		"startDate": "2026-07-20", "nextBillingDate": "2026-08-20",
	})
	buyout := createSchemaTestSubscriptionNoValidate(t, app, user.Id, map[string]interface{}{
		"name": "Historical Lifetime License", "price": "199", "billingCycle": "one-time",
		"oneTimeTermCount": 0, "oneTimeTermUnit": "", "autoRenew": false, "autoCalculateNextBillingDate": false,
		"startDate": "2026-08-10", "nextBillingDate": "2026-08-10",
	})
	fixed := createSchemaTestSubscriptionNoValidate(t, app, user.Id, map[string]interface{}{
		"name": "Historical Fixed Service", "price": "180", "billingCycle": "one-time",
		"oneTimeTermCount": 6, "oneTimeTermUnit": "month", "autoRenew": false, "autoCalculateNextBillingDate": false,
		"startDate": "2026-02-15", "nextBillingDate": "2026-08-15",
	})

	type factSnapshot struct {
		ID               string `db:"id"`
		Price            string `db:"price"`
		BillingCycle     string `db:"billingCycle"`
		StartDate        string `db:"startDate"`
		NextBillingDate  string `db:"nextBillingDate"`
		OneTimeTermCount int    `db:"oneTimeTermCount"`
		OneTimeTermUnit  string `db:"oneTimeTermUnit"`
		AutoRenew        bool   `db:"autoRenew"`
	}
	readFacts := func() []factSnapshot {
		var rows []factSnapshot
		if err := app.DB().NewQuery(`SELECT id, price, billingCycle, startDate, nextBillingDate,
			oneTimeTermCount, oneTimeTermUnit, autoRenew
			FROM subscriptions WHERE user = {:user} ORDER BY id`).
			Bind(dbx.Params{"user": user.Id}).All(&rows); err != nil {
			t.Fatal(err)
		}
		return rows
	}
	factsBeforeUpgrade := readFacts()

	if _, err := app.DB().NewQuery(`DELETE FROM ` + schemaDataMigrationsTable + `
		WHERE name = 'subscription_cycle_fields_v1'`).Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery("DROP TABLE subscription_list_index").Execute(); err != nil {
		t.Fatal(err)
	}
	// 旧签名只用于模拟跳版本数据库；启动必须把整组派生缓存替换，不能在热路径兼容缺列表。
	if _, err := app.DB().NewQuery(`CREATE TABLE subscription_list_index (
		subscription_id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		billing_cycle TEXT NOT NULL,
		next_billing_date TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`).Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery(`INSERT INTO subscription_list_index
		(subscription_id, user_id, billing_cycle, next_billing_date, created_at)
		VALUES ('stale-upgrade-row', {:user}, 'monthly', '1999-01-01', '')`).
		Bind(dbx.Params{"user": user.Id}).Execute(); err != nil {
		t.Fatal(err)
	}

	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	if factsAfterUpgrade := readFacts(); !reflect.DeepEqual(factsAfterUpgrade, factsBeforeUpgrade) {
		t.Fatalf("startup upgrade rewrote subscription facts:\nbefore=%#v\nafter=%#v", factsBeforeUpgrade, factsAfterUpgrade)
	}
	if current, err := subscriptionDerivedSchemaCurrent(app); err != nil || !current {
		t.Fatalf("derived schema current=%v err=%v, want true nil", current, err)
	}

	assertFiltered := func(query subscriptionListQuery, expected ...string) {
		t.Helper()
		query.Limit = 10
		rows, total, err := projectedSubscriptionPage(app, user.Id, query, "2026-08-25", subscriptionProjectionExactPage, 0)
		if err != nil {
			t.Fatal(err)
		}
		actual := make(map[string]bool, len(rows))
		for _, id := range subscriptionProjectionIDs(rows) {
			actual[id] = true
		}
		if total != int64(len(expected)) || len(actual) != len(expected) {
			t.Fatalf("filtered projection total=%d ids=%#v, want %#v", total, actual, expected)
		}
		for _, id := range expected {
			if !actual[id] {
				t.Fatalf("filtered projection ids=%#v, missing %q", actual, id)
			}
		}
	}
	assertFiltered(subscriptionListQuery{PaymentType: "auto"}, auto.Id)
	assertFiltered(subscriptionListQuery{PaymentType: "manual"}, manual.Id)
	assertFiltered(subscriptionListQuery{PaymentType: "one-time-buyout"}, buyout.Id)
	assertFiltered(subscriptionListQuery{PaymentType: "one-time-fixed-term"}, fixed.Id)
	assertFiltered(subscriptionListQuery{
		BillingCycles: []string{"one-time"}, PaymentType: "one-time-fixed-term",
		NextBillingFrom: "2026-08-01", NextBillingTo: "2026-08-31",
	}, fixed.Id)
	assertFiltered(subscriptionListQuery{NextBillingFrom: "2026-08-01", NextBillingTo: "2026-08-31"}, auto.Id, manual.Id, fixed.Id)

	type projectionSnapshot struct {
		SubscriptionID   string `db:"subscription_id"`
		BillingCycle     string `db:"billing_cycle"`
		OneTimeTermCount int    `db:"one_time_term_count"`
		AutoRenew        int    `db:"auto_renew"`
		NextBillingDate  string `db:"next_billing_date"`
	}
	readProjection := func() []projectionSnapshot {
		var rows []projectionSnapshot
		if err := app.DB().NewQuery(`SELECT subscription_id, billing_cycle, one_time_term_count,
			auto_renew, next_billing_date FROM subscription_list_index
			WHERE user_id = {:user} ORDER BY subscription_id`).
			Bind(dbx.Params{"user": user.Id}).All(&rows); err != nil {
			t.Fatal(err)
		}
		return rows
	}
	firstProjection := readProjection()
	if len(firstProjection) != 4 {
		t.Fatalf("rebuilt projection rows=%#v, want four facts and no stale row", firstProjection)
	}
	if applied, err := schemaDataMigrationApplied(app, "subscription_cycle_fields_v1"); err != nil || !applied {
		t.Fatalf("cycle migration marker applied=%v err=%v, want true nil", applied, err)
	}

	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	if secondProjection := readProjection(); !reflect.DeepEqual(secondProjection, firstProjection) {
		t.Fatalf("second startup changed rebuilt projection:\nfirst=%#v\nsecond=%#v", firstProjection, secondProjection)
	}
	if factsAfterSecondStart := readFacts(); !reflect.DeepEqual(factsAfterSecondStart, factsBeforeUpgrade) {
		t.Fatalf("second startup changed subscription facts: %#v", factsAfterSecondStart)
	}
}

func TestSchemaDataMigrationRunsOnceAndRetriesAfterFailure(t *testing.T) {
	app := newSchemaTestApp(t)
	attempts := 0
	migrationErr := errors.New("temporary failure")

	err := runSchemaDataMigration(app, "test_retry_after_failure", func(core.App) error {
		attempts++
		return migrationErr
	})
	if !errors.Is(err, migrationErr) {
		t.Fatalf("first migration error = %v, want %v", err, migrationErr)
	}
	if applied, err := schemaDataMigrationApplied(app, "test_retry_after_failure"); err != nil || applied {
		t.Fatalf("failed migration applied = %v err = %v, want false nil", applied, err)
	}

	err = runSchemaDataMigration(app, "test_retry_after_failure", func(core.App) error {
		attempts++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if attempts != 2 {
		t.Fatalf("attempts after retry = %d, want 2", attempts)
	}
	if applied, err := schemaDataMigrationApplied(app, "test_retry_after_failure"); err != nil || !applied {
		t.Fatalf("successful migration applied = %v err = %v, want true nil", applied, err)
	}

	err = runSchemaDataMigration(app, "test_retry_after_failure", func(core.App) error {
		attempts++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if attempts != 2 {
		t.Fatalf("attempts after applied rerun = %d, want 2", attempts)
	}
}

func TestSchemaDataMigrationsBackfillSchedulerWithoutListProjection(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureCollectionsSchema(app); err != nil {
		t.Fatal(err)
	}
	user := createSchemaTestUser(t, app, "schema-scheduler-backfill@example.com")
	createSchemaTestSubscriptionNoValidate(t, app, user.Id, map[string]interface{}{
		"name":      "Legacy Scheduler",
		"autoRenew": true,
	})

	if err := runSchemaDataMigrations(app); err != nil {
		t.Fatal(err)
	}
	if _, err := app.FindFirstRecordByFilter("subscription_scheduler_states", "user = {:user}", dbx.Params{"user": user.Id}); err != nil {
		t.Fatalf("expected scheduler state backfill: %v", err)
	}
	var projection struct {
		Count int `db:"count"`
	}
	if err := app.DB().NewQuery("SELECT COUNT(*) AS count FROM subscription_list_index WHERE user_id = {:user}").
		Bind(dbx.Params{"user": user.Id}).
		One(&projection); err != nil {
		t.Fatal(err)
	}
	if projection.Count != 0 {
		t.Fatalf("list projection count after startup migrations = %d, want 0", projection.Count)
	}
	if err := rebuildSubscriptionDerivedStateForUser(app, user.Id, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := app.DB().NewQuery("SELECT COUNT(*) AS count FROM subscription_list_index WHERE user_id = {:user}").
		Bind(dbx.Params{"user": user.Id}).
		One(&projection); err != nil {
		t.Fatal(err)
	}
	if projection.Count != 1 {
		t.Fatalf("list projection count after lazy refresh = %d, want 1", projection.Count)
	}
}

func TestSchemaDataMigrationsNormalizeSubscriptionCycleFieldsOnce(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureCollectionsSchema(app); err != nil {
		t.Fatal(err)
	}
	user := createSchemaTestUser(t, app, "schema-cycle-fields@example.com")
	custom := createSchemaTestSubscriptionNoValidate(t, app, user.Id, map[string]interface{}{
		"name":            "Legacy Custom",
		"billingCycle":    "custom",
		"customDays":      45,
		"customCycleUnit": "",
	})
	fixed := createSchemaTestSubscriptionNoValidate(t, app, user.Id, map[string]interface{}{
		"name":             "Fixed With Stale Fields",
		"billingCycle":     "monthly",
		"customDays":       30,
		"customCycleUnit":  "week",
		"oneTimeTermCount": 6,
		"oneTimeTermUnit":  "month",
	})

	if err := runSchemaDataMigrations(app); err != nil {
		t.Fatal(err)
	}
	reloadedCustom, err := app.FindRecordById("subscriptions", custom.Id)
	if err != nil {
		t.Fatal(err)
	}
	if reloadedCustom.GetInt("customDays") != 45 || reloadedCustom.GetString("customCycleUnit") != "day" {
		t.Fatalf("custom cycle = (%d, %q), want (45, day)", reloadedCustom.GetInt("customDays"), reloadedCustom.GetString("customCycleUnit"))
	}
	reloadedFixed, err := app.FindRecordById("subscriptions", fixed.Id)
	if err != nil {
		t.Fatal(err)
	}
	if reloadedFixed.GetInt("customDays") != 0 || reloadedFixed.GetString("customCycleUnit") != "" || reloadedFixed.GetInt("oneTimeTermCount") != 0 || reloadedFixed.GetString("oneTimeTermUnit") != "" {
		t.Fatalf("fixed cycle retained mutually exclusive fields: custom=(%d, %q) one-time=(%d, %q)", reloadedFixed.GetInt("customDays"), reloadedFixed.GetString("customCycleUnit"), reloadedFixed.GetInt("oneTimeTermCount"), reloadedFixed.GetString("oneTimeTermUnit"))
	}
}

func TestSchemaDataMigrationsBackfillCostSharingCollectionReminderMirrors(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureCollectionsSchema(app); err != nil {
		t.Fatal(err)
	}
	user := createSchemaTestUser(t, app, "schema-cost-sharing-backfill@example.com")
	record := createSchemaTestSubscriptionNoValidate(t, app, user.Id, map[string]interface{}{
		"name":         "Legacy Family Collection",
		"startDate":    "2026-05-14",
		"reminderDays": disabledReminderDays,
		"costSharing": types.JSONRaw(`{
			"enabled": true,
			"splitMode": "equal",
			"collectionReminder": {"enabled": true, "intervalMonths": 1, "reminderDays": -1},
			"members": [{"id": "partner", "name": "Partner", "currency": "USD"}]
		}`),
	})
	buyout := createSchemaTestSubscriptionNoValidate(t, app, user.Id, map[string]interface{}{
		"name":            "Legacy Buyout Collection",
		"billingCycle":    "one-time",
		"startDate":       "2026-05-14",
		"nextBillingDate": "2026-05-14",
		"reminderDays":    disabledReminderDays,
		"costSharing": types.JSONRaw(`{
			"enabled": true,
			"splitMode": "equal",
			"collectionReminder": {"enabled": true, "intervalMonths": 1, "reminderDays": -1},
			"members": [{"id": "partner", "name": "Partner", "currency": "USD"}]
		}`),
	})

	if err := runSchemaDataMigrations(app); err != nil {
		t.Fatal(err)
	}
	reloaded, err := app.FindRecordById("subscriptions", record.Id)
	if err != nil {
		t.Fatal(err)
	}
	if !reloaded.GetBool("costSharingCollectionReminderEnabled") || reloaded.GetString("costSharingNextCollectionReminderDate") == "" {
		t.Fatalf("expected collection reminder mirror backfill, enabled=%v next=%q", reloaded.GetBool("costSharingCollectionReminderEnabled"), reloaded.GetString("costSharingNextCollectionReminderDate"))
	}
	reloadedBuyout, err := app.FindRecordById("subscriptions", buyout.Id)
	if err != nil {
		t.Fatal(err)
	}
	if reloadedBuyout.GetBool("costSharingCollectionReminderEnabled") || reloadedBuyout.GetString("costSharingNextCollectionReminderDate") != "" {
		t.Fatalf("expected buyout collection mirror disabled, enabled=%v next=%q", reloadedBuyout.GetBool("costSharingCollectionReminderEnabled"), reloadedBuyout.GetString("costSharingNextCollectionReminderDate"))
	}
	data, err := jsonBytesFromValue(reloaded.Get("costSharing"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "collectionReminder") {
		t.Fatalf("expected public costSharing JSON to remain intact, got %s", data)
	}
	if strings.Contains(string(data), "intervalMonths") {
		t.Fatalf("expected deprecated collection interval to be removed, got %s", data)
	}
	buyoutData, err := jsonBytesFromValue(reloadedBuyout.Get("costSharing"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(buyoutData), "intervalMonths") {
		t.Fatalf("expected deprecated buyout collection interval to be removed, got %s", buyoutData)
	}
}

func createSchemaTestUser(t *testing.T, app core.App, email string) *core.Record {
	t.Helper()
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	user := core.NewRecord(users)
	user.SetEmail(email)
	user.SetPassword("password123")
	user.SetVerified(true)
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	return user
}

func createSchemaTestSubscriptionNoValidate(t *testing.T, app core.App, userID string, overrides map[string]interface{}) *core.Record {
	t.Helper()
	subscriptions, err := app.FindCollectionByNameOrId("subscriptions")
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(subscriptions)
	record.Set("user", userID)
	record.Set("name", "Schema Subscription")
	record.Set("price", "1")
	record.Set("currency", "USD")
	record.Set("billingCycle", "monthly")
	record.Set("category", "productivity")
	record.Set("status", "active")
	record.Set("startDate", "2026-05-14")
	record.Set("nextBillingDate", "2026-06-14")
	record.Set("autoRenew", false)
	record.Set("autoCalculateNextBillingDate", true)
	record.Set("tags", []string{})
	record.Set("costSharing", emptyJSONPayload{})
	record.Set("extra", emptyJSONPayload{})
	record.Set("reminderDays", 3)
	record.Set("repeatReminderEnabled", false)
	record.Set("repeatReminderInterval", defaultRepeatReminderInterval)
	record.Set("repeatReminderWindow", defaultRepeatReminderWindow)
	for key, value := range overrides {
		record.Set(key, value)
	}
	if err := app.SaveNoValidate(record); err != nil {
		t.Fatal(err)
	}
	return record
}
