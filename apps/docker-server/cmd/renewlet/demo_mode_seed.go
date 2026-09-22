package main

import (
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// Demo seed 只生成可恢复的公开演示基线；真实通知、云备份和 AI 凭据必须保持空值，避免共享账号触发外部副作用。
func seedDemoSettings(app core.App, userID string) error {
	collection, err := app.FindCollectionByNameOrId("settings")
	if err != nil {
		return err
	}
	settings := defaultAppSettings()
	settings.AdminUsername = demoModePolicy.Name
	settings.DefaultCurrency = "CNY"
	settings.PublicStatusCurrency = "inherit"
	// 价格 catalog 覆盖多币种，demo 默认展示 CNY 参考价，避免访客先改设置才能看懂折算效果。
	settings.SubscriptionPriceReferenceEnabled = true
	settings.SubscriptionPriceReferenceCurrency = "CNY"
	settings.MonthlyBudget = "800"
	settings.Timezone = demoModeScheduleTimezone
	settings.NotificationTimeLocal = "09:00"
	// 公开 demo 允许浏览设置页，但默认不启用真实通知渠道，避免 reset 前的共享账号触达外部服务。
	settings.EnabledChannels = []string{}
	record := core.NewRecord(collection)
	record.Set("user", userID)
	record.Set("settings", settings)
	return app.Save(record)
}

func seedDemoSubscriptions(app core.App, userID string, now time.Time) error {
	collection, err := app.FindCollectionByNameOrId("subscriptions")
	if err != nil {
		return err
	}
	for _, seed := range demoSubscriptionSeeds(now) {
		record := core.NewRecord(collection)
		record.Set("user", userID)
		record.Set("name", seed.Name)
		record.Set("logo", seed.logoURL())
		record.Set("price", seed.Price)
		record.Set("currency", seed.Currency)
		record.Set("billingCycle", seed.BillingCycle)
		record.Set("customDays", seed.CustomDays)
		record.Set("customCycleUnit", seed.CustomCycleUnit)
		record.Set("oneTimeTermCount", seed.OneTimeTermCount)
		record.Set("oneTimeTermUnit", seed.OneTimeTermUnit)
		record.Set("category", seed.Category)
		record.Set("status", seed.Status)
		record.Set("pinned", seed.Pinned)
		record.Set("publicHidden", seed.PublicHidden)
		record.Set("paymentMethod", seed.PaymentMethod)
		record.Set("startDate", seed.StartDate)
		record.Set("nextBillingDate", seed.NextBillingDate)
		record.Set("autoRenew", seed.AutoRenew)
		record.Set("autoCalculateNextBillingDate", seed.AutoCalculateNextBillingDate)
		record.Set("trialEndDate", seed.TrialEndDate)
		record.Set("website", seed.Website)
		record.Set("notes", seed.Notes)
		record.Set("tags", seed.Tags)
		// extra 是演示数据的可审计来源边界；reset 只重建 catalog 记录，访客临时新增订阅不能伪装成价格快照。
		record.Set("extra", map[string]interface{}{
			"demo":           true,
			"slug":           seed.Slug,
			"order":          seed.Order,
			"source":         "public-pricing-demo",
			"sourceUrl":      seed.Website,
			"pricingSource":  seed.PricingSource,
			"priceCheckedAt": demoModePriceCheckedAt,
			"planLabel":      seed.PlanLabel,
			"priceBasis":     seed.PriceBasis,
			"priceSnapshot": map[string]interface{}{
				"amount":       seed.Price,
				"currency":     seed.Currency,
				"billingCycle": seed.BillingCycle,
				"planLabel":    seed.PlanLabel,
				"basis":        seed.PriceBasis,
			},
		})
		record.Set("reminderDays", seed.ReminderDays)
		record.Set("repeatReminderEnabled", seed.RepeatReminderEnabled)
		record.Set("repeatReminderInterval", seed.RepeatReminderInterval)
		record.Set("repeatReminderWindow", seed.RepeatReminderWindow)
		if err := app.Save(record); err != nil {
			return err
		}
	}
	return nil
}
