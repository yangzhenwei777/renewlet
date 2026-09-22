package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

func migrateCostSharingCurrentUserPayerShape(app core.App) error {
	for offset := 0; ; offset += subscriptionCleanupPageSize {
		rows, err := app.FindRecordsByFilter("subscriptions", "id != ''", "created", subscriptionCleanupPageSize, offset)
		if err != nil {
			return err
		}
		for _, record := range rows {
			if err := migrateCostSharingCurrentUserPayerRecord(app, record); err != nil {
				return err
			}
		}
		if len(rows) < subscriptionCleanupPageSize {
			return nil
		}
	}
}

func migrateCostSharingCurrentUserPayerRecord(app core.App, record *core.Record) error {
	data, err := jsonBytesFromValue(record.Get("costSharing"))
	if err != nil {
		return err
	}
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "{}" {
		return nil
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil
	}
	changed := false
	selfMemberID, _ := payload["selfMemberId"].(string)
	// 旧 PR 形状把“我/付款人/是否参与”写进成员 JSON；新契约固定当前账户付款，成员数组只表示其他人的应收金额。
	for _, key := range []string{"payerMemberId", "selfMemberId"} {
		if _, ok := payload[key]; ok {
			delete(payload, key)
			changed = true
		}
	}
	if members, ok := payload["members"].([]interface{}); ok {
		nextMembers := members[:0]
		for _, item := range members {
			member, ok := item.(map[string]interface{})
			if !ok {
				nextMembers = append(nextMembers, item)
				continue
			}
			if strings.TrimSpace(selfMemberID) != "" && strings.TrimSpace(fmt.Sprint(member["id"])) == strings.TrimSpace(selfMemberID) {
				changed = true
				continue
			}
			if _, ok := member["included"]; ok {
				delete(member, "included")
				changed = true
			}
			nextMembers = append(nextMembers, member)
		}
		if len(nextMembers) != len(members) {
			payload["members"] = nextMembers
		}
		if len(nextMembers) == 0 {
			record.Set("costSharing", emptyJSONPayload{})
			return app.SaveNoValidate(record)
		}
	}
	if !changed {
		return nil
	}
	record.Set("costSharing", payload)
	return app.SaveNoValidate(record)
}
