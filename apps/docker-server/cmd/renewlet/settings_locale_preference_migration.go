package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	settingsLocalePreferenceMigrationPageSize = 200
	settingsLocalePreferenceInsertGuardName   = "renewlet_settings_locale_contract_insert"
	settingsLocalePreferenceUpdateGuardName   = "renewlet_settings_locale_contract_update"
)

// 白名单是持久化契约，新增语言必须追加新的 guard 迁移，不能原地改写已安装 trigger 的期望定义。
const (
	settingsLocalePreferenceGuardV1AllowList = `'auto', 'zh-CN', 'en-US'`
	settingsLocalePreferenceGuardAllowList   = `'auto', 'zh-CN', 'en-US', 'ru-RU'`
)

func settingsLocalePreferenceGuardCondition(allowList string) string {
	return `CASE
		WHEN json_valid(NEW.settings) = 0 THEN 1
		WHEN json_type(NEW.settings) IS NOT 'object' THEN 1
		WHEN EXISTS (SELECT 1 FROM json_each(NEW.settings) GROUP BY key HAVING COUNT(*) > 1) THEN 1
		WHEN json_type(NEW.settings, '$.locale') IS NOT NULL THEN 1
	WHEN json_type(NEW.settings, '$.localePreference') IS NOT 'text' THEN 1
	WHEN json_extract(NEW.settings, '$.localePreference') NOT IN (` + allowList + `) THEN 1
	ELSE 0
END = 1`
}

func settingsLocalePreferenceGuardStatements(allowList string) map[string]string {
	condition := settingsLocalePreferenceGuardCondition(allowList)
	return map[string]string{
		settingsLocalePreferenceInsertGuardName: `CREATE TRIGGER ` + settingsLocalePreferenceInsertGuardName + `
		BEFORE INSERT ON settings FOR EACH ROW WHEN ` + condition + `
		BEGIN SELECT RAISE(ABORT, 'SETTINGS_LOCALE_CONTRACT_INVALID'); END`,
		settingsLocalePreferenceUpdateGuardName: `CREATE TRIGGER ` + settingsLocalePreferenceUpdateGuardName + `
		BEFORE UPDATE OF settings ON settings FOR EACH ROW WHEN ` + condition + `
		BEGIN SELECT RAISE(ABORT, 'SETTINGS_LOCALE_CONTRACT_INVALID'); END`,
	}
}

var (
	settingsLocalePreferenceGuardV1SQL = settingsLocalePreferenceGuardStatements(settingsLocalePreferenceGuardV1AllowList)
	settingsLocalePreferenceGuardSQL   = settingsLocalePreferenceGuardStatements(settingsLocalePreferenceGuardAllowList)
)

func preflightSettingsLocalePreferenceMigration(app core.App) error {
	exists, err := sqliteObjectExists(app, "table", "settings")
	if err != nil || !exists {
		return err
	}
	return visitSettingsLocalePreferenceRecords(app, func(settingsLocalePreferenceRow, map[string]json.RawMessage) error { return nil })
}

func migrateSettingsLocalePreference(app core.App) error {
	return visitSettingsLocalePreferenceRecords(app, func(row settingsLocalePreferenceRow, fields map[string]json.RawMessage) error {
		return migrateSettingsLocalePreferenceRecord(app, row, fields)
	})
}

type settingsLocalePreferenceRow struct {
	ID       string `db:"id"`
	Settings string `db:"settings"`
}

func visitSettingsLocalePreferenceRecords(app core.App, visit func(settingsLocalePreferenceRow, map[string]json.RawMessage) error) error {
	lastID := ""
	for {
		rows := make([]settingsLocalePreferenceRow, 0, settingsLocalePreferenceMigrationPageSize)
		err := app.DB().NewQuery(`SELECT id, settings FROM settings
			WHERE id > {:lastID} ORDER BY id LIMIT {:limit}`).
			Bind(dbx.Params{"lastID": lastID, "limit": settingsLocalePreferenceMigrationPageSize}).
			All(&rows)
		if err != nil {
			return err
		}
		for _, row := range rows {
			fields, err := settingsLocalePreferenceFields(row)
			if err != nil {
				return err
			}
			if err := visit(row, fields); err != nil {
				return err
			}
		}
		if len(rows) < settingsLocalePreferenceMigrationPageSize {
			return nil
		}
		lastID = rows[len(rows)-1].ID
	}
}

func settingsLocalePreferenceFields(row settingsLocalePreferenceRow) (map[string]json.RawMessage, error) {
	data := []byte(row.Settings)
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, fmt.Errorf("settings record %s is empty", row.ID)
	}
	fields, err := decodeUniqueSettingsObject(data)
	if err != nil {
		return nil, fmt.Errorf("settings record %s contains unsafe JSON: %w", row.ID, err)
	}
	return fields, nil
}

func decodeUniqueSettingsObject(data []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	opening, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if delimiter, ok := opening.(json.Delim); !ok || delimiter != '{' {
		return nil, errors.New("value is not a JSON object")
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errors.New("object key is not a string")
		}
		if _, exists := fields[key]; exists {
			return nil, fmt.Errorf("duplicate top-level field %q", key)
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		fields[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	if err := decoder.Decode(new(interface{})); err != io.EOF {
		if err == nil {
			return nil, errors.New("unexpected data after JSON object")
		}
		return nil, err
	}
	return fields, nil
}

// 旧 locale 只在这次迁移中提升为明确账号偏好；每条写回后都验证非语言字段语义不变。
func migrateSettingsLocalePreferenceRecord(app core.App, row settingsLocalePreferenceRow, fields map[string]json.RawMessage) error {
	before, err := settingsWithoutLocaleFields(fields)
	if err != nil {
		return fmt.Errorf("snapshot settings record %s: %w", row.ID, err)
	}

	preference := string(autoLocalePreference)
	if current, ok := migrationStringField(fields, "localePreference"); ok && isSupportedLocalePreference(current) {
		preference = current
	} else if legacyLocale, ok := migrationStringField(fields, "locale"); ok && isSupportedAppLocale(legacyLocale) {
		preference = legacyLocale
	}
	encodedPreference, _ := json.Marshal(preference)
	fields["localePreference"] = encodedPreference
	delete(fields, "locale")

	encoded, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	if _, err := app.DB().NewQuery("UPDATE settings SET settings = {:settings} WHERE id = {:id}").
		Bind(dbx.Params{"id": row.ID, "settings": string(encoded)}).
		Execute(); err != nil {
		return err
	}
	var reloaded settingsLocalePreferenceRow
	if err := app.DB().NewQuery("SELECT id, settings FROM settings WHERE id = {:id} LIMIT 1").
		Bind(dbx.Params{"id": row.ID}).
		One(&reloaded); err != nil {
		return err
	}
	afterFields, err := settingsLocalePreferenceFields(reloaded)
	if err != nil {
		return err
	}
	after, err := settingsWithoutLocaleFields(afterFields)
	if err != nil {
		return err
	}
	if !bytes.Equal(before, after) {
		return fmt.Errorf("settings record %s changed outside locale fields", row.ID)
	}
	return nil
}

func settingsWithoutLocaleFields(fields map[string]json.RawMessage) ([]byte, error) {
	copyFields := make(map[string]json.RawMessage, len(fields))
	for key, value := range fields {
		if key != "locale" && key != "localePreference" {
			copyFields[key] = value
		}
	}
	return json.Marshal(copyFields)
}

func verifySettingsLocalePreferenceInvariant(app core.App) error {
	exists, err := sqliteObjectExists(app, "table", "settings")
	if err != nil || !exists {
		return err
	}
	return visitSettingsLocalePreferenceRecords(app, func(row settingsLocalePreferenceRow, fields map[string]json.RawMessage) error {
		if _, ok := fields["locale"]; ok {
			return fmt.Errorf("settings record %s still contains locale", row.ID)
		}
		preference, ok := migrationStringField(fields, "localePreference")
		if !ok || !isSupportedLocalePreference(preference) {
			return fmt.Errorf("settings record %s has invalid localePreference", row.ID)
		}
		return nil
	})
}

func installSettingsLocalePreferenceGuard(app core.App) error {
	for _, name := range []string{settingsLocalePreferenceInsertGuardName, settingsLocalePreferenceUpdateGuardName} {
		if _, err := app.DB().NewQuery(settingsLocalePreferenceGuardSQL[name]).Execute(); err != nil {
			return err
		}
	}
	return nil
}

// 这里只复核历史 v1 账本：旧库尚为 v1，重启的新库已为 v2；随后 guard_v2 必须收敛并严格复核当前定义。
// 不能在此只认 v2 而阻断旧库升级，也不能把两代定义的过渡复核用于最终运行时校验。
func verifySettingsLocalePreferenceGuardV1(app core.App) error {
	return verifySettingsLocalePreferenceGuardDefinitions(app, settingsLocalePreferenceGuardV1SQL, settingsLocalePreferenceGuardSQL)
}

func verifySettingsLocalePreferenceGuard(app core.App) error {
	return verifySettingsLocalePreferenceGuardDefinitions(app, settingsLocalePreferenceGuardSQL)
}

func verifySettingsLocalePreferenceGuardDefinitions(app core.App, accepted ...map[string]string) error {
	for _, name := range []string{settingsLocalePreferenceInsertGuardName, settingsLocalePreferenceUpdateGuardName} {
		var row struct {
			SQL string `db:"sql"`
		}
		err := app.DB().NewQuery(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = {:name} LIMIT 1`).
			Bind(dbx.Params{"name": name}).
			One(&row)
		if err != nil {
			return err
		}
		matched := false
		for _, statements := range accepted {
			if normalizeSQLiteSchemaSQL(row.SQL) == normalizeSQLiteSchemaSQL(statements[name]) {
				matched = true
				break
			}
		}
		if !matched {
			return fmt.Errorf("trigger %s definition mismatch", name)
		}
	}
	return nil
}

// guard_v2 只替换白名单，不改写 settings；DROP、CREATE 与完成标记由调用方放在同一事务，失败必须恢复旧 guard。
func replaceSettingsLocalePreferenceGuard(app core.App) error {
	for _, name := range []string{settingsLocalePreferenceInsertGuardName, settingsLocalePreferenceUpdateGuardName} {
		if _, err := app.DB().NewQuery(`DROP TRIGGER IF EXISTS ` + name).Execute(); err != nil {
			return err
		}
	}
	return installSettingsLocalePreferenceGuard(app)
}

func migrationStringField(fields map[string]json.RawMessage, key string) (string, bool) {
	raw, ok := fields[key]
	if !ok {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}
