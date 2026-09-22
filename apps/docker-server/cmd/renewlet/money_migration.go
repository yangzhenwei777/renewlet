package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const legacySubscriptionPriceNumberColumn = "_renewlet_price_number_legacy"

func subscriptionPriceTextField() *core.TextField {
	return &core.TextField{Name: "price", Required: true, Max: 32}
}

// migrateLegacySubscriptionPriceNumberField 必须早于 schema 收敛；PocketBase 会先拒绝字段 type 变化，旧 number 值来不及进入普通 record 迁移。
func migrateLegacySubscriptionPriceNumberField(app core.App) error {
	collection, err := app.FindCollectionByNameOrId("subscriptions")
	if err != nil {
		return nil
	}

	priceField := collection.Fields.GetByName("price")
	legacyColumnExists, err := tableColumnExists(app, "subscriptions", legacySubscriptionPriceNumberColumn)
	if err != nil {
		return err
	}
	if priceField == nil {
		if !legacyColumnExists {
			return nil
		}
		if err := upsertField(collection, subscriptionPriceTextField()); err != nil {
			return err
		}
		if err := app.Save(collection); err != nil {
			return err
		}
		return backfillLegacySubscriptionPriceNumberColumn(app)
	}

	switch priceField.Type() {
	case core.FieldTypeText:
		if legacyColumnExists {
			return backfillLegacySubscriptionPriceNumberColumn(app)
		}
		return nil
	case core.FieldTypeNumber:
	default:
		return fmt.Errorf("collection %q field %q type mismatch: existing %q, expected %q", collection.Name, "price", priceField.Type(), core.FieldTypeText)
	}

	if !app.HasTable("subscriptions") {
		collection.Fields.RemoveByName("price")
		if err := app.SaveNoValidate(collection); err != nil {
			return err
		}
		if err := upsertField(collection, subscriptionPriceTextField()); err != nil {
			return err
		}
		return app.Save(collection)
	}

	if !legacyColumnExists {
		if _, err := app.DB().AddColumn("subscriptions", legacySubscriptionPriceNumberColumn, "TEXT NOT NULL DEFAULT ''").Execute(); err != nil {
			return err
		}
	}
	if _, err := app.DB().NewQuery(fmt.Sprintf(
		"UPDATE `subscriptions` SET `%s` = CAST(COALESCE(`price`, 0) AS TEXT)",
		legacySubscriptionPriceNumberColumn,
	)).Execute(); err != nil {
		return err
	}

	// PocketBase 按 field id 禁止原地改 type；先删除旧 NumberField 再新增 TextField，才能让表同步真实重建 price 列。
	collection.Fields.RemoveByName("price")
	if err := app.SaveNoValidate(collection); err != nil {
		return err
	}
	if err := upsertField(collection, subscriptionPriceTextField()); err != nil {
		return err
	}
	if err := app.Save(collection); err != nil {
		return err
	}
	return backfillLegacySubscriptionPriceNumberColumn(app)
}

func backfillLegacySubscriptionPriceNumberColumn(app core.App) error {
	exists, err := tableColumnExists(app, "subscriptions", legacySubscriptionPriceNumberColumn)
	if err != nil || !exists {
		return err
	}
	rows := []struct {
		ID          string `db:"id"`
		LegacyPrice string `db:"legacy_price"`
	}{}
	if err := app.DB().NewQuery(fmt.Sprintf(
		"SELECT `id`, `%s` AS `legacy_price` FROM `subscriptions`",
		legacySubscriptionPriceNumberColumn,
	)).All(&rows); err != nil {
		return err
	}
	for _, row := range rows {
		legacyPrice := strings.TrimSpace(row.LegacyPrice)
		if legacyPrice == "" {
			legacyPrice = "0"
		}
		price, err := canonicalMoneyFromNumberString(legacyPrice)
		if err != nil {
			return fmt.Errorf("subscription %s legacy price: %w", row.ID, err)
		}
		if _, err := app.DB().NewQuery("UPDATE `subscriptions` SET `price` = {:price} WHERE `id` = {:id}").
			Bind(dbx.Params{"id": row.ID, "price": price}).
			Execute(); err != nil {
			return err
		}
	}
	// 临时列只跨一次启动迁移保存旧 number，不是长期兼容字段；清掉它可防止后续维护者误读为双写契约。
	_, err = app.DB().DropColumn("subscriptions", legacySubscriptionPriceNumberColumn).Execute()
	return err
}

func tableColumnExists(app core.App, tableName string, columnName string) (bool, error) {
	if !app.HasTable(tableName) {
		return false, nil
	}
	columns, err := app.TableColumns(tableName)
	if err != nil {
		return false, err
	}
	for _, column := range columns {
		if column == columnName {
			return true, nil
		}
	}
	return false, nil
}

// migrateMoneyStrings 把旧 number 金额一次性提升成 canonical decimal string；之后 API/storage 都不再维持双形状。
func migrateMoneyStrings(app core.App) error {
	if err := migrateSubscriptionMoneyStrings(app); err != nil {
		return err
	}
	return migrateSettingsMoneyStrings(app)
}

func migrateSubscriptionMoneyStrings(app core.App) error {
	for offset := 0; ; offset += subscriptionCleanupPageSize {
		rows, err := app.FindRecordsByFilter("subscriptions", "id != ''", "created", subscriptionCleanupPageSize, offset)
		if err != nil {
			return err
		}
		for _, record := range rows {
			price, err := canonicalMoneyFromValue(record.Get("price"))
			if err != nil {
				return fmt.Errorf("subscription %s price: %w", record.Id, err)
			}
			changed := !recordMoneyValueEquals(record.Get("price"), price)
			record.Set("price", price)
			if costSharing, costSharingChanged, err := normalizeStoredCostSharingMoney(record.Get("costSharing")); err != nil {
				return fmt.Errorf("subscription %s costSharing: %w", record.Id, err)
			} else if costSharingChanged {
				record.Set("costSharing", costSharing)
				changed = true
			}
			if !changed {
				continue
			}
			if err := app.SaveNoValidate(record); err != nil {
				return err
			}
		}
		if len(rows) < subscriptionCleanupPageSize {
			return nil
		}
	}
}

func recordMoneyValueEquals(value interface{}, canonical string) bool {
	text, ok := value.(string)
	return ok && text == canonical
}

func migrateSettingsMoneyStrings(app core.App) error {
	for offset := 0; ; offset += subscriptionCleanupPageSize {
		rows, err := app.FindRecordsByFilter("settings", "user != ''", "created", subscriptionCleanupPageSize, offset)
		if err != nil {
			return err
		}
		for _, record := range rows {
			settings, changed, err := normalizeStoredSettingsMoney(record.Get("settings"))
			if err != nil {
				return fmt.Errorf("settings %s monthlyBudget: %w", record.Id, err)
			}
			if !changed {
				continue
			}
			record.Set("settings", settings)
			if err := app.SaveNoValidate(record); err != nil {
				return err
			}
		}
		if len(rows) < subscriptionCleanupPageSize {
			return nil
		}
	}
}

func normalizeStoredSettingsMoney(value interface{}) (map[string]interface{}, bool, error) {
	data, err := jsonBytesFromValue(value)
	if err != nil || len(bytes.TrimSpace(data)) == 0 {
		return nil, false, err
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, false, err
	}
	value, ok := payload["monthlyBudget"]
	if !ok {
		return payload, false, nil
	}
	amount, err := canonicalMoneyFromValue(value)
	if err != nil {
		return nil, false, err
	}
	if existing, ok := value.(string); ok && existing == amount {
		return payload, false, nil
	}
	payload["monthlyBudget"] = amount
	return payload, true, nil
}

func normalizeStoredCostSharingMoney(value interface{}) (map[string]interface{}, bool, error) {
	data, err := jsonBytesFromValue(value)
	if err != nil || len(bytes.TrimSpace(data)) == 0 || string(bytes.TrimSpace(data)) == "{}" {
		return nil, false, err
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, false, err
	}
	members, ok := payload["members"].([]interface{})
	if !ok {
		return payload, false, nil
	}
	changed := false
	for _, item := range members {
		member, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		value, ok := member["customAmount"]
		if !ok || value == nil {
			continue
		}
		amount, err := canonicalMoneyFromValue(value)
		if err != nil {
			return nil, false, err
		}
		if existing, ok := value.(string); ok && existing == amount {
			continue
		}
		member["customAmount"] = amount
		changed = true
	}
	return payload, changed, nil
}
