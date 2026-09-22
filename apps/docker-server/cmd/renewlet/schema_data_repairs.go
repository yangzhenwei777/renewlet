package main

import (
	"fmt"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func backfillAutodates(app core.App, names ...string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, name := range names {
		// names 只来自内部常量列表；WHERE 把旧库修复限制在缺系统时间的行，避免启动迁移写放大全表。
		_, err := app.DB().NewQuery(fmt.Sprintf(
			"UPDATE `%s` SET `created` = CASE WHEN `created` = '' THEN {:now} ELSE `created` END, `updated` = CASE WHEN `updated` = '' THEN {:now} ELSE `updated` END WHERE `created` = '' OR `updated` = ''",
			name,
		)).Bind(dbx.Params{"now": now}).Execute()
		if err != nil {
			return err
		}
	}
	return nil
}

func backfillSubscriptionAutoRenew(app core.App) error {
	// autoRenew 默认关闭；迁移只修正 one-time 约束，不把历史缺省周期订阅解释成自动续订授权。
	_, err := app.DB().NewQuery(
		"UPDATE `subscriptions` SET `autoRenew` = 0 WHERE `billingCycle` = 'one-time'",
	).Execute()
	return err
}

func cleanupInvalidSubscriptionLogos(app core.App) error {
	afterID := ""
	for {
		var rows []struct {
			ID string `db:"id"`
		}
		// SQL 只缩小“明显可疑”的候选范围；真正是否合法仍由 validateOptionalLogoReference 决定，避免维护两套 Logo 契约。
		if err := app.DB().NewQuery(`SELECT id FROM subscriptions
			WHERE id > {:afterID}
				AND logo != ''
				AND (
					(logo NOT LIKE '/api/app/assets/%' AND logo NOT LIKE 'http://%' AND logo NOT LIKE 'https://%')
					OR logo LIKE 'http://%@%'
					OR logo LIKE 'https://%@%'
				)
			ORDER BY id
			LIMIT {:limit}`).
			Bind(dbx.Params{"afterID": afterID, "limit": subscriptionCleanupPageSize}).
			All(&rows); err != nil {
			return err
		}
		for _, row := range rows {
			afterID = row.ID
			record, err := app.FindRecordById("subscriptions", row.ID)
			if err != nil {
				return err
			}
			if validateOptionalLogoReference(record.GetString("logo")) == nil {
				continue
			}
			// 破坏性切换只清空不再支持的持久化 Logo 形态；HTTP 外链仍是自托管 HTTP 场景的合法值。
			record.Set("logo", "")
			if err := app.SaveNoValidate(record); err != nil {
				return err
			}
		}
		if len(rows) < subscriptionCleanupPageSize {
			return nil
		}
	}
}

func deleteOrphanSubscriptionCalendarFeeds(app core.App) error {
	// Docker 的 subscriptionId 是文本投影，没有 D1 外键级联；一次性迁移先清掉旧版本留下的孤儿。
	_, err := app.DB().NewQuery(`DELETE FROM calendar_feeds
		WHERE scope = 'subscription'
			AND NOT EXISTS (
				SELECT 1 FROM subscriptions
				WHERE subscriptions.id = calendar_feeds.subscriptionId
					AND subscriptions.user = calendar_feeds.user
			)`).Execute()
	return err
}
