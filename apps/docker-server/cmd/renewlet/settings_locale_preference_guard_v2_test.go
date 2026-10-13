package main

import (
	"fmt"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func TestSettingsLocalePreferenceGuardAllowListMatchesSupportedLocales(t *testing.T) {
	expected := []string{"'" + string(autoLocalePreference) + "'"}
	for _, locale := range supportedAppLocales {
		expected = append(expected, "'"+string(locale)+"'")
	}
	if got, want := settingsLocalePreferenceGuardAllowList, strings.Join(expected, ", "); got != want {
		t.Fatalf("guard allow-list = %s, want %s; add a new guard migration when supported locales change", got, want)
	}
}

func TestSettingsLocalePreferenceGuardV2UpgradesLegacyTrigger(t *testing.T) {
	app := newSchemaTestApp(t)
	seedSettingsLocalePreferenceGuardV1(t, app)

	insert := func(id string, settings string) error {
		user := createSchemaTestUser(t, app, "locale-guard-v2-"+strings.ReplaceAll(id, "_", "-")+"@example.com")
		_, err := app.DB().NewQuery(`INSERT INTO settings (id, user, settings, created, updated)
			VALUES ({:id}, {:user}, {:settings}, '', '')`).Bind(dbx.Params{
			"id":       id,
			"user":     user.Id,
			"settings": settings,
		}).Execute()
		return err
	}
	if err := insert("legacy_ru", `{"localePreference":"ru-RU"}`); err == nil || !strings.Contains(err.Error(), "SETTINGS_LOCALE_CONTRACT_INVALID") {
		t.Fatalf("v1 guard should reject ru-RU, got %v", err)
	}
	if err := insert("existing_en", `{"localePreference":"en-US","monthlyBudget":"42"}`); err != nil {
		t.Fatal(err)
	}

	if err := runSchemaDataMigrations(app); err != nil {
		t.Fatalf("guard v2 upgrade failed: %v", err)
	}
	if err := verifySettingsLocalePreferenceGuard(app); err != nil {
		t.Fatalf("guard v2 not installed: %v", err)
	}

	if err := insert("upgraded_ru", `{"localePreference":"ru-RU"}`); err != nil {
		t.Fatalf("v2 guard should accept ru-RU, got %v", err)
	}
	if err := insert("upgraded_fr", `{"localePreference":"fr-FR"}`); err == nil || !strings.Contains(err.Error(), "SETTINGS_LOCALE_CONTRACT_INVALID") {
		t.Fatalf("v2 guard should still reject unsupported locales, got %v", err)
	}
	var stored struct {
		Settings string `db:"settings"`
	}
	if err := app.DB().NewQuery("SELECT settings FROM settings WHERE id = 'existing_en'").One(&stored); err != nil {
		t.Fatal(err)
	}
	if want := `{"localePreference":"en-US","monthlyBudget":"42"}`; stored.Settings != want {
		t.Fatalf("guard v2 changed settings data: got %s want %s", stored.Settings, want)
	}

	if err := runSchemaDataMigrations(app); err != nil {
		t.Fatalf("second startup after guard v2 failed: %v", err)
	}
	if _, err := app.DB().NewQuery("DROP TRIGGER " + settingsLocalePreferenceInsertGuardName).Execute(); err != nil {
		t.Fatal(err)
	}
	if err := runSchemaDataMigrations(app); err == nil || !strings.Contains(err.Error(), "guard drift") {
		t.Fatal(fmt.Errorf("guard v2 drift validation error = %v", err))
	}
}

func seedSettingsLocalePreferenceGuardV1(t *testing.T, app core.App) {
	t.Helper()
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	for name, statement := range settingsLocalePreferenceGuardV1SQL {
		if _, err := app.DB().NewQuery("DROP TRIGGER IF EXISTS " + name).Execute(); err != nil {
			t.Fatal(err)
		}
		if _, err := app.DB().NewQuery(statement).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := app.DB().NewQuery("DELETE FROM " + schemaDataMigrationsTable + " WHERE name = {:name}").
		Bind(dbx.Params{"name": settingsLocalePreferenceGuardV2MigrationName}).
		Execute(); err != nil {
		t.Fatal(err)
	}
}

func TestSettingsLocalePreferenceGuardV2MarkerFailureRollsBackAndRetries(t *testing.T) {
	app := newSchemaTestApp(t)
	seedSettingsLocalePreferenceGuardV1(t, app)
	// 在替换 trigger 后阻断完成标记，确保不会留下“新 guard、旧账本”的半升级状态。
	if _, err := app.DB().NewQuery(`CREATE TRIGGER fail_locale_guard_marker BEFORE INSERT ON ` + schemaDataMigrationsTable + `
		WHEN NEW.name = 'settings_locale_preference_guard_v2'
		BEGIN SELECT RAISE(ABORT, 'injected locale marker failure'); END`).Execute(); err != nil {
		t.Fatal(err)
	}
	if err := runSchemaDataMigrations(app); err == nil || !strings.Contains(err.Error(), "injected locale marker failure") {
		t.Fatalf("marker failure = %v", err)
	}
	if err := verifySettingsLocalePreferenceGuardDefinitions(app, settingsLocalePreferenceGuardV1SQL); err != nil {
		t.Fatalf("failed transaction did not restore both v1 guards: %v", err)
	}
	if applied, err := schemaDataMigrationApplied(app, settingsLocalePreferenceGuardV2MigrationName); err != nil || applied {
		t.Fatalf("failed transaction published marker: applied=%v err=%v", applied, err)
	}
	if _, err := app.DB().NewQuery("DROP TRIGGER fail_locale_guard_marker").Execute(); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := runSchemaDataMigrations(app); err != nil {
			t.Fatalf("retry/restart failed: %v", err)
		}
		if err := verifySettingsLocalePreferenceGuard(app); err != nil {
			t.Fatal(err)
		}
	}
	// v2 账本一旦提交，退回完整 v1 定义也属于漂移，不能因 v1 的过渡复核被接受。
	for name, statement := range settingsLocalePreferenceGuardV1SQL {
		if _, err := app.DB().NewQuery("DROP TRIGGER " + name).Execute(); err != nil {
			t.Fatal(err)
		}
		if _, err := app.DB().NewQuery(statement).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	if err := runSchemaDataMigrations(app); err == nil || !strings.Contains(err.Error(), settingsLocalePreferenceGuardV2MigrationName+" guard drift") {
		t.Fatalf("completed v2 accepted old guards: %v", err)
	}
}
