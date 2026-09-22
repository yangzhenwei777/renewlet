package main

import (
	"bytes"
	"encoding/json"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// migrateCostSharingCollectionReminderInheritedCycle 删除旧 intervalMonths 公共字段，并按订阅周期重建内部镜像。
func migrateCostSharingCollectionReminderInheritedCycle(app core.App) error {
	return backfillCostSharingCollectionReminderMirrors(app)
}

// backfillCostSharingCollectionReminderMirrors 从 costSharing JSON 派生内部索引列，并移除上一版短暂公开过的周期字段。
func backfillCostSharingCollectionReminderMirrors(app core.App) error {
	for offset := 0; ; offset += subscriptionCleanupPageSize {
		rows, err := app.FindRecordsByFilter("subscriptions", "id != ''", "created", subscriptionCleanupPageSize, offset)
		if err != nil {
			return err
		}
		for _, record := range rows {
			costSharingValue, costSharingChanged, err := normalizeStoredCostSharingCollectionReminderContract(record.Get("costSharing"))
			if err != nil {
				return err
			}
			settings := settingsForSubscriptionMirror(app, record.GetString("user"))
			referenceDate := costSharingCollectionReminderReferenceDate(settings, time.Now().UTC())
			enabled, nextDate := costSharingCollectionReminderMirror(costSharingValue, costSharingCollectionBillingFromRecord(record), settings, referenceDate)
			if !costSharingChanged &&
				record.GetBool("costSharingCollectionReminderEnabled") == enabled &&
				record.GetString("costSharingNextCollectionReminderDate") == nextDate {
				continue
			}
			// costSharing JSON 是用户配置事实源；迁移只移除废弃 intervalMonths，不写回任何派生周期值。
			record.Set("costSharing", costSharingValue)
			record.Set("costSharingCollectionReminderEnabled", enabled)
			record.Set("costSharingNextCollectionReminderDate", nextDate)
			if err := app.SaveNoValidate(record); err != nil {
				return err
			}
		}
		if len(rows) < subscriptionCleanupPageSize {
			return nil
		}
	}
}

func normalizeStoredCostSharingCollectionReminderContract(value interface{}) (interface{}, bool, error) {
	data, err := jsonBytesFromValue(value)
	if err != nil || len(bytes.TrimSpace(data)) == 0 || string(bytes.TrimSpace(data)) == "{}" {
		return emptyJSONPayload{}, false, err
	}
	raw := map[string]interface{}{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return value, false, err
	}
	changed := false
	if reminder, ok := raw["collectionReminder"].(map[string]interface{}); ok {
		if _, exists := reminder["intervalMonths"]; exists {
			delete(reminder, "intervalMonths")
			changed = true
		}
	}
	if !changed {
		return value, false, nil
	}
	normalized, err := normalizeCostSharing(raw)
	if err != nil {
		return value, false, err
	}
	return normalized, true, nil
}
