package main

// notification_repeat.go 收拢重复提醒枚举、默认值和时间窗口计算。
//
// 架构位置：subscriptions schema/hooks、通知内容计算和 cron 调度都依赖这里的枚举，
// 避免前端可选项、后端校验和历史快照出现分叉。
import (
	"strings"
	"time"
)

const (
	defaultRepeatReminderInterval = "1h"
	defaultRepeatReminderWindow   = "72h"
)

var repeatReminderIntervals = map[string]time.Duration{
	"1h":  time.Hour,
	"3h":  3 * time.Hour,
	"6h":  6 * time.Hour,
	"12h": 12 * time.Hour,
	"24h": 24 * time.Hour,
}

var repeatReminderWindows = map[string]time.Duration{
	"24h": 24 * time.Hour,
	"48h": 48 * time.Hour,
	"72h": 72 * time.Hour,
}

func normalizeRepeatReminderInterval(value string) string {
	value = strings.TrimSpace(value)
	if _, ok := repeatReminderIntervals[value]; ok {
		return value
	}
	return defaultRepeatReminderInterval
}

func normalizeRepeatReminderWindow(value string) string {
	value = strings.TrimSpace(value)
	if value == "full" {
		return value
	}
	if _, ok := repeatReminderWindows[value]; ok {
		return value
	}
	return defaultRepeatReminderWindow
}

func isValidRepeatReminderInterval(value string) bool {
	_, ok := repeatReminderIntervals[strings.TrimSpace(value)]
	return ok
}

func isValidRepeatReminderWindow(value string) bool {
	value = strings.TrimSpace(value)
	if value == "full" {
		return true
	}
	_, ok := repeatReminderWindows[value]
	return ok
}

func repeatReminderIntervalDuration(value string) time.Duration {
	if duration, ok := repeatReminderIntervals[normalizeRepeatReminderInterval(value)]; ok {
		return duration
	}
	return repeatReminderIntervals[defaultRepeatReminderInterval]
}

func repeatReminderWindowDuration(value string) (time.Duration, bool) {
	value = normalizeRepeatReminderWindow(value)
	if value == "full" {
		return 0, true
	}
	return repeatReminderWindows[value], false
}

func repeatReminderIntervalHours(value string) int {
	return int(repeatReminderIntervalDuration(value).Hours())
}

func getRepeatScheduleDecision(now time.Time, settings appSettings, subscriptions []notificationSubscription, windowMinutes int) localScheduleDecision {
	for _, sub := range subscriptions {
		if isDisabledReminderDays(sub.ReminderDays) {
			// -2 静默订阅不参与 repeat due，否则会绕过主通知的跳过入口。
			continue
		}
		if sub.BillingCycle == "one-time" || !sub.RepeatReminderEnabled {
			continue
		}
		repeat := repeatReminderSnapshot{
			Interval: normalizeRepeatReminderInterval(sub.RepeatReminderInterval),
			Window:   normalizeRepeatReminderWindow(sub.RepeatReminderWindow),
		}
		// 先检查续费，再检查试用；同一个 tick 只需要命中一次，真正的 items 收集会再聚合所有订阅。
		reminderDays, ok := effectiveReminderDays(sub, settings)
		if !ok {
			continue
		}
		if occurrence, ok := repeatReminderDueOccurrence(now, settings, reminderDays, sub.NextBillingDate, repeat, windowMinutes); ok {
			return localScheduleDecision{localScheduleOccurrence: occurrence, Due: true, Reason: "repeat_reminder_due"}
		}
		if sub.Status == "trial" {
			if occurrence, ok := repeatReminderDueOccurrence(now, settings, reminderDays, sub.TrialEndDate, repeat, windowMinutes); ok {
				return localScheduleDecision{localScheduleOccurrence: occurrence, Due: true, Reason: "repeat_reminder_due"}
			}
		}
	}
	return localScheduleDecision{Due: false, Reason: "no_repeat_reminder_due"}
}

func repeatReminderDueOccurrence(now time.Time, settings appSettings, reminderDays int, targetDate string, repeat repeatReminderSnapshot, windowMinutes int) (localScheduleOccurrence, bool) {
	if !isValidDateOnly(targetDate) {
		return localScheduleOccurrence{}, false
	}
	targetInstant, err := getScheduleInstant(targetDate, settings.NotificationTimeLocal, settings.Timezone)
	if err != nil {
		return localScheduleOccurrence{}, false
	}
	firstInstant, err := getScheduleInstant(addDateOnly(targetDate, -reminderDays), settings.NotificationTimeLocal, settings.Timezone)
	if err != nil {
		return localScheduleOccurrence{}, false
	}
	interval := repeatReminderIntervalDuration(repeat.Interval)
	if interval <= 0 {
		return localScheduleOccurrence{}, false
	}
	elapsedNow := now.UTC().Sub(firstInstant)
	if elapsedNow <= 0 {
		return localScheduleOccurrence{}, false
	}
	// 用整除定位“最近一个已到达的重复提醒点”，避免从 firstInstant 开始逐个 interval 扫描。
	steps := int(elapsedNow / interval)
	if steps < 1 {
		return localScheduleOccurrence{}, false
	}
	candidate := firstInstant.Add(time.Duration(steps) * interval)
	if candidate.After(targetInstant) {
		return localScheduleOccurrence{}, false
	}
	windowStart := firstInstant
	if duration, full := repeatReminderWindowDuration(repeat.Window); !full {
		limited := targetInstant.Add(-duration)
		if limited.After(windowStart) {
			// 有限窗口只保留目标日期前 N 小时的重复提醒，避免早期提醒周期太密。
			windowStart = limited
		}
	}
	if candidate.Before(windowStart) {
		return localScheduleOccurrence{}, false
	}
	deltaMinutes := int(now.UTC().Sub(candidate).Minutes())
	if deltaMinutes < 0 || deltaMinutes > maxInt(windowMinutes, 0) {
		return localScheduleOccurrence{}, false
	}
	return localScheduleOccurrenceFromInstant(candidate, settings.Timezone), true
}

func localScheduleOccurrenceFromInstant(instant time.Time, timezone string) localScheduleOccurrence {
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		loc = time.UTC
		timezone = "UTC"
	}
	local := instant.In(loc)
	return localScheduleOccurrence{
		ScheduledLocalDate:  local.Format("2006-01-02"),
		ScheduledLocalTime:  local.Format("15:04"),
		TimeZone:            timezone,
		ScheduledInstantUTC: instant.UTC().Format(time.RFC3339),
	}
}

func getNextRepeatScheduleOccurrence(now time.Time, settings appSettings, subscriptions []notificationSubscription) (localScheduleOccurrence, bool) {
	var next localScheduleOccurrence
	var nextInstant time.Time
	found := false
	for _, sub := range subscriptions {
		if isDisabledReminderDays(sub.ReminderDays) {
			// 下一次预览也跳过 -2，避免 UI 显示一条不会发送的重复提醒。
			continue
		}
		if sub.BillingCycle == "one-time" || !sub.RepeatReminderEnabled {
			continue
		}
		repeat := repeatReminderSnapshot{
			Interval: normalizeRepeatReminderInterval(sub.RepeatReminderInterval),
			Window:   normalizeRepeatReminderWindow(sub.RepeatReminderWindow),
		}
		candidates := []string{sub.NextBillingDate}
		if sub.Status == "trial" {
			candidates = append(candidates, sub.TrialEndDate)
		}
		reminderDays, ok := effectiveReminderDays(sub, settings)
		if !ok {
			continue
		}
		for _, targetDate := range candidates {
			occurrence, ok := nextRepeatOccurrenceAfter(now, settings, reminderDays, targetDate, repeat)
			if !ok {
				continue
			}
			instant, err := time.Parse(time.RFC3339, occurrence.ScheduledInstantUTC)
			if err != nil {
				continue
			}
			if !found || instant.Before(nextInstant) {
				next = occurrence
				nextInstant = instant
				found = true
			}
		}
	}
	return next, found
}

func nextRepeatOccurrenceAfter(now time.Time, settings appSettings, reminderDays int, targetDate string, repeat repeatReminderSnapshot) (localScheduleOccurrence, bool) {
	if !isValidDateOnly(targetDate) {
		return localScheduleOccurrence{}, false
	}
	targetInstant, err := getScheduleInstant(targetDate, settings.NotificationTimeLocal, settings.Timezone)
	if err != nil {
		return localScheduleOccurrence{}, false
	}
	firstInstant, err := getScheduleInstant(addDateOnly(targetDate, -reminderDays), settings.NotificationTimeLocal, settings.Timezone)
	if err != nil {
		return localScheduleOccurrence{}, false
	}
	interval := repeatReminderIntervalDuration(repeat.Interval)
	if interval <= 0 {
		return localScheduleOccurrence{}, false
	}
	windowStart := firstInstant
	if duration, full := repeatReminderWindowDuration(repeat.Window); !full {
		limited := targetInstant.Add(-duration)
		if limited.After(windowStart) {
			windowStart = limited
		}
	}
	start := now.UTC()
	if windowStart.After(start) {
		// 下一次预览从有效窗口起点算起，否则“24h 窗口”会显示窗口外的重复提醒。
		start = windowStart
	}
	elapsed := start.Sub(firstInstant)
	steps := int(elapsed / interval)
	if firstInstant.Add(time.Duration(steps)*interval).Before(start) || firstInstant.Add(time.Duration(steps)*interval).Equal(firstInstant) {
		// 若刚好落在 firstInstant，仍要推进到第一个重复点；首提醒由日常提醒负责，不重复显示。
		steps++
	}
	if steps < 1 {
		steps = 1
	}
	candidate := firstInstant.Add(time.Duration(steps) * interval)
	if !candidate.After(now.UTC()) {
		candidate = candidate.Add(interval)
	}
	if candidate.After(targetInstant) || candidate.Before(windowStart) {
		return localScheduleOccurrence{}, false
	}
	return localScheduleOccurrenceFromInstant(candidate, settings.Timezone), true
}

func collectUpcomingRepeatBatches(now time.Time, settings appSettings, subscriptions []notificationSubscription, days int) []upcomingNotificationBatch {
	end := now.UTC().Add(time.Duration(maxInt(days, 1)) * 24 * time.Hour)
	batchesByKey := map[string]*upcomingNotificationBatch{}
	for _, sub := range subscriptions {
		if isDisabledReminderDays(sub.ReminderDays) {
			// 批次聚合跳过 -2，保证未来预览和实际 Cron 同源。
			continue
		}
		if !sub.RepeatReminderEnabled {
			continue
		}
		repeat := repeatReminderSnapshot{
			Interval: normalizeRepeatReminderInterval(sub.RepeatReminderInterval),
			Window:   normalizeRepeatReminderWindow(sub.RepeatReminderWindow),
		}
		targets := []struct {
			itemType string
			date     string
		}{{itemType: "renewal", date: sub.NextBillingDate}}
		if sub.Status == "trial" {
			targets = append(targets, struct {
				itemType string
				date     string
			}{itemType: "trial", date: sub.TrialEndDate})
		}
		reminderDays, ok := effectiveReminderDays(sub, settings)
		if !ok {
			continue
		}
		for _, target := range targets {
			occurrence, ok := nextRepeatOccurrenceAfter(now, settings, reminderDays, target.date, repeat)
			for ok {
				instant, err := time.Parse(time.RFC3339, occurrence.ScheduledInstantUTC)
				if err != nil || instant.After(end) {
					break
				}
				item := newNotificationContentItem(target.itemType, sub, target.date, daysBetweenDateOnly(occurrence.ScheduledLocalDate, target.date), reminderDays, &repeat)
				// 当前订阅已足够构造 occurrence item；禁止在内层重新扫描全部订阅。
				appendUpcomingBatch(batchesByKey, occurrence, []notificationContentItem{item})
				// 下一轮从当前 occurrence 后一分钟开始，避免 nextRepeatOccurrenceAfter 返回同一个时间点造成死循环。
				occurrence, ok = nextRepeatOccurrenceAfter(instant.Add(time.Minute), settings, reminderDays, target.date, repeat)
			}
		}
	}
	out := make([]upcomingNotificationBatch, 0, len(batchesByKey))
	for _, batch := range batchesByKey {
		out = append(out, *batch)
	}
	return out
}

func appendUpcomingBatch(batches map[string]*upcomingNotificationBatch, occurrence localScheduleOccurrence, items []notificationContentItem) {
	if len(items) == 0 {
		return
	}
	key := occurrence.ScheduledLocalDate + "|" + occurrence.ScheduledLocalTime + "|" + occurrence.TimeZone
	batch, ok := batches[key]
	if !ok {
		// 同一用户同一分钟可能有多个订阅命中，按调度 key 合并成一个历史/预览批次。
		batches[key] = &upcomingNotificationBatch{
			localScheduleOccurrence: occurrence,
			Items:                   uniqueNotificationItems(items),
		}
		return
	}
	batch.Items = uniqueNotificationItems(append(batch.Items, items...))
}

func uniqueNotificationItems(items []notificationContentItem) []notificationContentItem {
	seen := map[string]struct{}{}
	out := make([]notificationContentItem, 0, len(items))
	for _, item := range items {
		repeatKey := ""
		if item.RepeatReminder != nil {
			repeatKey = item.RepeatReminder.Interval + "/" + item.RepeatReminder.Window
		}
		collectionKey := ""
		if item.CostSharing != nil {
			collectionKey = item.CostSharing.MemberName + "/" + item.CostSharing.Amount + "/" + item.CostSharing.Currency
		}
		key := item.Type + "|" + item.SubscriptionID + "|" + item.TargetDate + "|" + repeatKey + "|" + collectionKey
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, item)
	}
	return out
}
