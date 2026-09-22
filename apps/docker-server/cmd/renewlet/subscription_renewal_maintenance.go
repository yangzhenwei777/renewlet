package main

// subscription_renewal_maintenance.go 注册 Docker/Go 自动续订维护任务。
//
// 维护任务按用户时区计算 today，并在通知生成前幂等推进 autoRenew 订阅，
// 避免已自动续订的记录仍用旧账单日进入 expired/renewal 通知。
import (
	"log/slog"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const subscriptionRenewalMaintenancePageSize = 500

var subscriptionRenewalCronMu sync.Mutex

func positiveRecurringBillingCycleFilter(field string) string {
	// 正向枚举让自动续订候选查询命中复合索引；!= one-time 在 D1/PocketBase 下都容易退化成宽扫描。
	return "(" + field + " = 'weekly' || " +
		field + " = 'monthly' || " +
		field + " = 'quarterly' || " +
		field + " = 'semi-annual' || " +
		field + " = 'annual' || " +
		field + " = 'custom')"
}

type subscriptionRenewalMaintenanceResult struct {
	UsersProcessed       int
	SubscriptionsUpdated int
}

func registerSubscriptionRenewalCron(app core.App) error {
	if !envBool("SUBSCRIPTION_RENEWAL_SCHEDULER_ENABLED", true) {
		return nil
	}
	expr := envString("SUBSCRIPTION_RENEWAL_SCHEDULER_CRON", "* * * * *")
	return app.Cron().Add("renewlet_subscription_renewals", expr, func() {
		if !subscriptionRenewalCronMu.TryLock() {
			// Cron tick 可能因慢数据库或大量用户重叠；跳过重入比并发推进同一订阅更安全。
			slog.Info("subscription renewal maintenance skipped overlapping tick")
			return
		}
		defer subscriptionRenewalCronMu.Unlock()

		result, err := renewAutoSubscriptionsForAllUsers(app, time.Now())
		if err != nil {
			slog.Error("subscription renewal maintenance failed", "error", err)
			return
		}
		if result.SubscriptionsUpdated > 0 {
			slog.Info("subscription renewal maintenance completed",
				"users", result.UsersProcessed,
				"updated", result.SubscriptionsUpdated,
			)
		}
	})
}

func renewAutoSubscriptionsForAllUsers(app core.App, now time.Time) (subscriptionRenewalMaintenanceResult, error) {
	result := subscriptionRenewalMaintenanceResult{}
	for {
		userIDs, err := listAutoRenewDueUserIDs(app, now, subscriptionRenewalMaintenancePageSize)
		if err != nil {
			return result, err
		}
		// due-index 只决定本轮候选用户；真正是否已处理今天仍由单用户 state gate 决定。
		for _, userID := range userIDs {
			settings := schedulerSettingsForUser(app, userID)
			updated, err := renewAutoSubscriptionsForUser(app, userID, settings.Timezone, now)
			if err != nil {
				return result, err
			}
			result.UsersProcessed++
			result.SubscriptionsUpdated += updated
		}
		if len(userIDs) < subscriptionRenewalMaintenancePageSize {
			return result, nil
		}
	}
}

func renewAutoSubscriptionsForUser(app core.App, userID string, timezone string, now time.Time) (int, error) {
	if userID == "" {
		return 0, nil
	}
	if demoModePolicy.IsUserID(app, userID) {
		// 手动通知概览也会调用该 helper；这里统一跳过，避免 demo 只读预览路径产生写库副作用。
		return 0, nil
	}
	state, err := getSubscriptionSchedulerState(app, userID)
	if err != nil {
		return 0, err
	}
	if state.AutoRenewCount <= 0 {
		return 0, nil
	}
	today := todayDateOnly(now, timezone)
	if state.LastAutoRenewLocalDate == today {
		return 0, nil
	}
	updated := 0
	for {
		pageUpdated := 0
		// 每轮都从第 0 页按 nextBillingDate 重新查；更新后记录会离开条件，避免 offset 跳过跨多期过期项。
		rows, err := app.FindRecordsByFilter(
			"subscriptions",
			"user = {:user} && autoRenew = true && "+positiveRecurringBillingCycleFilter("billingCycle")+" && nextBillingDate < {:today} && (status = 'active' || status = 'trial')",
			"nextBillingDate",
			subscriptionRenewalMaintenancePageSize,
			0,
			dbx.Params{"user": userID, "today": today},
		)
		if err != nil {
			return updated, err
		}
		for _, record := range rows {
			result, ok, err := advanceSubscriptionRenewal(subscriptionRenewalInputFromRecord(record), today, renewalModeAuto)
			if err != nil {
				return updated, err
			}
			if !ok {
				continue
			}
			record.Set("nextBillingDate", result.NextBillingDate)
			record.Set("status", result.Status)
			if err := app.Save(record); err != nil {
				return updated, err
			}
			updated++
			pageUpdated++
		}
		if pageUpdated == 0 || len(rows) < subscriptionRenewalMaintenancePageSize {
			if err := markSubscriptionAutoRenewChecked(app, userID, today); err != nil {
				return updated, err
			}
			return updated, nil
		}
	}
}
