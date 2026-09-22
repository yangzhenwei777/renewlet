package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func settingsLocalePreferenceMigrationForTest() schemaDataMigration {
	return schemaDataMigration{
		Name: settingsLocalePreferenceMigrationName,
		Run:  migrateSettingsLocalePreference,
		Exclusive: &exclusiveSchemaDataMigration{
			Preflight:    preflightSettingsLocalePreferenceMigration,
			Verify:       verifySettingsLocalePreferenceInvariant,
			InstallGuard: installSettingsLocalePreferenceGuard,
			VerifyGuard:  verifySettingsLocalePreferenceGuard,
		},
	}
}

func TestSettingsLocalePreferenceMigrationReplacesLegacyField(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureCollectionsSchema(app); err != nil {
		t.Fatal(err)
	}
	settingsCollection, err := app.FindCollectionByNameOrId("settings")
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name     string
		settings map[string]interface{}
		want     string
	}{
		{name: "legacy Chinese", settings: map[string]interface{}{"locale": "zh-CN", "monthlyBudget": "2333"}, want: "zh-CN"},
		{name: "legacy English", settings: map[string]interface{}{"locale": "en-US"}, want: "en-US"},
		{name: "invalid legacy", settings: map[string]interface{}{"locale": "fr-FR"}, want: "auto"},
		{name: "missing legacy", settings: map[string]interface{}{"monthlyBudget": "2333"}, want: "auto"},
		{name: "existing new preference wins", settings: map[string]interface{}{"locale": "en-US", "localePreference": "zh-CN"}, want: "zh-CN"},
	}

	records := make(map[string]*core.Record, len(tests))
	for _, tt := range tests {
		user := createSchemaTestUser(t, app, "locale-migration-"+strings.ReplaceAll(tt.name, " ", "-")+"@example.com")
		record := core.NewRecord(settingsCollection)
		record.Set("user", user.Id)
		record.Set("settings", tt.settings)
		if err := app.SaveNoValidate(record); err != nil {
			t.Fatal(err)
		}
		records[tt.name] = record
	}

	if err := runExclusiveSchemaDataMigration(app, settingsLocalePreferenceMigrationForTest()); err != nil {
		t.Fatal(err)
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reloaded, err := app.FindRecordById("settings", records[tt.name].Id)
			if err != nil {
				t.Fatal(err)
			}
			data, err := jsonBytesFromValue(reloaded.Get("settings"))
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(data, &fields); err != nil {
				t.Fatal(err)
			}
			if _, ok := fields["locale"]; ok {
				t.Fatalf("expected legacy locale key to be removed, got %s", data)
			}
			var preference string
			if err := json.Unmarshal(fields["localePreference"], &preference); err != nil {
				t.Fatal(err)
			}
			if preference != tt.want {
				t.Fatalf("localePreference = %q, want %q; settings=%s", preference, tt.want, data)
			}
			if tt.name == "legacy Chinese" {
				var budget string
				if err := json.Unmarshal(fields["monthlyBudget"], &budget); err != nil || budget != "2333" {
					t.Fatalf("monthlyBudget changed during locale migration: value=%q err=%v", budget, err)
				}
			}
		})
	}
}

func TestSettingsLocalePreferenceMigrationFailsClosedWithoutMarker(t *testing.T) {
	for index, value := range []interface{}{"not-json", []interface{}{"not-an-object"}, nil} {
		t.Run(fmt.Sprintf("case-%d", index), func(t *testing.T) {
			app := newSchemaTestApp(t)
			if err := ensureCollectionsSchema(app); err != nil {
				t.Fatal(err)
			}
			user := createSchemaTestUser(t, app, fmt.Sprintf("damaged-%d@example.com", index))
			collection, err := app.FindCollectionByNameOrId("settings")
			if err != nil {
				t.Fatal(err)
			}
			record := core.NewRecord(collection)
			record.Set("user", user.Id)
			record.Set("settings", value)
			if err := app.SaveNoValidate(record); err != nil {
				t.Fatal(err)
			}

			if err := runExclusiveSchemaDataMigration(app, settingsLocalePreferenceMigrationForTest()); err == nil {
				t.Fatalf("migration accepted damaged settings value %#v", value)
			}
			exists, err := sqliteObjectExists(app, "table", schemaDataMigrationsTable)
			if err != nil {
				t.Fatal(err)
			}
			if exists {
				if applied, err := schemaDataMigrationApplied(app, settingsLocalePreferenceMigrationName); err != nil || applied {
					t.Fatalf("failed migration marker applied=%v err=%v", applied, err)
				}
			}
		})
	}
}

func TestSettingsLocalePreferenceMigrationRejectsDuplicateTopLevelFields(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureCollectionsSchema(app); err != nil {
		t.Fatal(err)
	}
	user := createSchemaTestUser(t, app, "duplicate-locale-fields@example.com")
	raw := `{"locale":"zh-CN","monthlyBudget":"1","monthlyBudget":"2"}`
	if _, err := app.DB().NewQuery(`INSERT INTO settings (id, user, settings, created, updated)
		VALUES ('duplicate_locale', {:user}, {:settings}, '', '')`).
		Bind(dbx.Params{"user": user.Id, "settings": raw}).
		Execute(); err != nil {
		t.Fatal(err)
	}

	if err := runExclusiveSchemaDataMigration(app, settingsLocalePreferenceMigrationForTest()); err == nil || !strings.Contains(err.Error(), "duplicate top-level field") {
		t.Fatalf("duplicate settings migration error = %v", err)
	}
	var stored struct {
		Settings string `db:"settings"`
	}
	if err := app.DB().NewQuery("SELECT settings FROM settings WHERE id = 'duplicate_locale'").One(&stored); err != nil {
		t.Fatal(err)
	}
	if stored.Settings != raw {
		t.Fatalf("failed migration changed settings: got %s want %s", stored.Settings, raw)
	}
}

func TestSettingsLocalePreferenceGuardRejectsLegacyWritersAndDrift(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	user := createSchemaTestUser(t, app, "locale-guard@example.com")

	invalidValues := []string{
		`{"locale":"zh-CN"}`,
		`{"monthlyBudget":"42"}`,
		`{"localePreference":"fr-FR"}`,
		`{"localePreference":"auto","monthlyBudget":"1","monthlyBudget":"2"}`,
		`not-json`,
	}
	for index, value := range invalidValues {
		_, err := app.DB().NewQuery(`INSERT INTO settings (id, user, settings, created, updated)
			VALUES ({:id}, {:user}, {:settings}, '', '')`).Bind(dbx.Params{
			"id":       fmt.Sprintf("guard_%d", index),
			"user":     user.Id,
			"settings": value,
		}).Execute()
		if err == nil || !strings.Contains(err.Error(), "SETTINGS_LOCALE_CONTRACT_INVALID") {
			t.Fatalf("guard error for %q = %v", value, err)
		}
	}

	if _, err := app.DB().NewQuery("DROP TRIGGER " + settingsLocalePreferenceUpdateGuardName).Execute(); err != nil {
		t.Fatal(err)
	}
	if err := runSchemaDataMigrations(app); err == nil || !strings.Contains(err.Error(), "guard drift") {
		t.Fatalf("guard drift validation error = %v", err)
	}
}
