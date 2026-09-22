package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type costSharingPayload struct {
	Enabled            bool                           `json:"enabled"`
	SplitMode          string                         `json:"splitMode"`
	Members            []costSharingMember            `json:"members"`
	CollectionReminder *costSharingCollectionReminder `json:"collectionReminder,omitempty"`
}

type costSharingMember struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Note         string  `json:"note,omitempty"`
	JoinedDate   string  `json:"joinedDate,omitempty"`
	Currency     string  `json:"currency,omitempty"`
	CustomAmount *string `json:"customAmount,omitempty"`
}

type costSharingCollectionReminder struct {
	Enabled      bool `json:"enabled"`
	ReminderDays *int `json:"reminderDays"`
}

type costSharingCollectionBilling struct {
	BillingCycle     string
	CustomDays       int
	CustomCycleUnit  string
	OneTimeTermCount int
	OneTimeTermUnit  string
	StartDate        string
	NextBillingDate  string
}

// normalizeCostSharing 是 Docker 持久层的 costSharing 契约门：当前用户固定付款，members 只保存其他人的应收金额。
func normalizeCostSharing(value interface{}) (interface{}, error) {
	data, err := jsonBytesFromValue(value)
	if err != nil || len(bytes.TrimSpace(data)) == 0 || string(bytes.TrimSpace(data)) == "{}" {
		return emptyJSONPayload{}, err
	}
	var payload costSharingPayload
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return nil, errors.New("COST_SHARING_JSON_INVALID")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, errors.New("COST_SHARING_JSON_INVALID")
	}
	if !payload.Enabled {
		if payload.CollectionReminder != nil && payload.CollectionReminder.Enabled {
			return nil, errors.New("COST_SHARING_COLLECTION_REMINDER_INVALID")
		}
		return emptyJSONPayload{}, nil
	}
	if payload.SplitMode != "equal" && payload.SplitMode != "custom" {
		return nil, errors.New("COST_SHARING_SPLIT_MODE_INVALID")
	}
	if len(payload.Members) == 0 || len(payload.Members) > 20 {
		return nil, errors.New("COST_SHARING_MEMBERS_INVALID")
	}
	ids := map[string]struct{}{}
	for index := range payload.Members {
		member := &payload.Members[index]
		member.ID = strings.TrimSpace(member.ID)
		member.Name = strings.TrimSpace(member.Name)
		member.Note = strings.TrimSpace(member.Note)
		member.JoinedDate = strings.TrimSpace(member.JoinedDate)
		member.Currency = strings.TrimSpace(member.Currency)
		if member.ID == "" || member.Name == "" || len([]rune(member.ID)) > 80 || len([]rune(member.Name)) > 80 {
			return nil, errors.New("COST_SHARING_MEMBER_INVALID")
		}
		if len([]rune(member.Note)) > 500 {
			return nil, errors.New("COST_SHARING_MEMBER_NOTE_TOO_LONG")
		}
		if member.JoinedDate != "" {
			// joinedDate 是家庭收款周期的 date-only anchor；不能保存 datetime，否则不同运行面会在时区边界算出不同提醒日。
			if err := requireDateOnly(member.JoinedDate, "COST_SHARING_MEMBER_JOINED"); err != nil {
				return nil, err
			}
		}
		if member.Currency != "" && !currencyCodeRe.MatchString(member.Currency) {
			return nil, errors.New("COST_SHARING_MEMBER_CURRENCY_INVALID")
		}
		if _, exists := ids[member.ID]; exists {
			return nil, errors.New("COST_SHARING_MEMBER_DUPLICATE")
		}
		ids[member.ID] = struct{}{}
		if member.CustomAmount != nil {
			amount, err := canonicalMoneyString(*member.CustomAmount)
			if err != nil {
				return nil, errors.New("COST_SHARING_CUSTOM_AMOUNT_INVALID")
			}
			member.CustomAmount = &amount
		}
		if payload.SplitMode == "custom" {
			if member.CustomAmount == nil {
				return nil, errors.New("COST_SHARING_CUSTOM_AMOUNT_INVALID")
			}
		}
	}
	if payload.CollectionReminder != nil {
		if payload.CollectionReminder.ReminderDays == nil {
			return nil, errors.New("COST_SHARING_COLLECTION_REMINDER_DAYS_INVALID")
		}
		// 收款提醒只保存开关和提前天数；周期继承订阅 billingCycle，避免两个周期事实源互相冲突。
		if *payload.CollectionReminder.ReminderDays < inheritReminderDays || *payload.CollectionReminder.ReminderDays > maxReminderDays {
			return nil, errors.New("COST_SHARING_COLLECTION_REMINDER_DAYS_INVALID")
		}
	}
	return payload, nil
}

func costSharingPayloadFromValue(value interface{}) (costSharingPayload, bool) {
	data, err := jsonBytesFromValue(value)
	if err != nil || len(bytes.TrimSpace(data)) == 0 || string(bytes.TrimSpace(data)) == "{}" {
		return costSharingPayload{}, false
	}
	var payload costSharingPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return costSharingPayload{}, false
	}
	return payload, payload.Enabled && len(payload.Members) > 0
}

func costSharingCollectionAnchorsSatisfied(value interface{}, subscriptionStartDate string) bool {
	payload, ok := costSharingPayloadFromValue(value)
	if !ok || payload.CollectionReminder == nil || !payload.CollectionReminder.Enabled {
		return true
	}
	for _, member := range payload.Members {
		if costSharingMemberCollectionAnchor(member, subscriptionStartDate) == "" {
			return false
		}
	}
	return true
}

func costSharingMemberJoinedDatesWithinRange(value interface{}, billing costSharingCollectionBilling) bool {
	payload, ok := costSharingPayloadFromValue(value)
	if !ok {
		return true
	}
	minDate := ""
	if isValidDateOnly(billing.StartDate) {
		minDate = billing.StartDate
	}
	maxDate := ""
	if !costSharingCollectionOneTimeBuyout(billing) && isValidDateOnly(billing.NextBillingDate) {
		maxDate = billing.NextBillingDate
	}
	for _, member := range payload.Members {
		if member.JoinedDate == "" {
			continue
		}
		if minDate != "" && member.JoinedDate < minDate {
			return false
		}
		if maxDate != "" && member.JoinedDate > maxDate {
			return false
		}
	}
	return true
}

func costSharingCollectionReminderEnabled(value interface{}) bool {
	payload, ok := costSharingPayloadFromValue(value)
	return ok && payload.CollectionReminder != nil && payload.CollectionReminder.Enabled
}

func costSharingCollectionReminderMirror(value interface{}, billing costSharingCollectionBilling, settings appSettings, referenceDate string) (bool, string) {
	payload, ok := costSharingPayloadFromValue(value)
	if costSharingCollectionOneTimeBuyout(billing) || !ok || payload.CollectionReminder == nil || !payload.CollectionReminder.Enabled ||
		payload.CollectionReminder.ReminderDays == nil {
		return false, ""
	}
	reminderDays, ok := effectiveCostSharingCollectionReminderDaysFromConfig(*payload.CollectionReminder.ReminderDays, settings)
	if !ok || !isValidDateOnly(referenceDate) {
		return false, ""
	}
	targetThreshold := addDateOnly(referenceDate, reminderDays)
	earliest := ""
	for _, member := range payload.Members {
		anchor := costSharingMemberCollectionAnchor(member, billing.StartDate)
		if anchor == "" {
			continue
		}
		targetDate, ok := nextCostSharingCollectionTargetDate(anchor, billing, targetThreshold)
		if !ok {
			continue
		}
		reminderDate := addDateOnly(targetDate, -reminderDays)
		if earliest == "" || reminderDate < earliest {
			earliest = reminderDate
		}
	}
	if earliest == "" {
		return false, ""
	}
	// 镜像列保存下一次提醒触发日期，只服务 cron 索引候选；costSharing JSON 仍是配置事实源。
	return true, earliest
}

func settingsForSubscriptionMirror(app core.App, userID string) appSettings {
	if strings.TrimSpace(userID) == "" {
		return defaultAppSettings()
	}
	_, settings, err := settingsRecordOrDefault(app, userID)
	if err != nil {
		return defaultAppSettings()
	}
	return settings
}

func effectiveCostSharingCollectionReminderDaysFromConfig(days int, settings appSettings) (int, bool) {
	if days == inheritReminderDays {
		return normalizeNotificationReminderDays(settings.NotificationReminderDays), true
	}
	if days < 0 || days > maxReminderDays {
		return 0, false
	}
	return days, true
}

func costSharingMemberCollectionAnchor(member costSharingMember, subscriptionStartDate string) string {
	if member.JoinedDate != "" && isValidDateOnly(member.JoinedDate) {
		return member.JoinedDate
	}
	if subscriptionStartDate != "" && isValidDateOnly(subscriptionStartDate) {
		return subscriptionStartDate
	}
	return ""
}

func nextCostSharingCollectionTargetDate(anchor string, billing costSharingCollectionBilling, referenceDate string) (string, bool) {
	anchorDate, err := parseDateOnly(anchor)
	if err != nil || !isValidDateOnly(referenceDate) || costSharingCollectionOneTimeBuyout(billing) {
		return "", false
	}
	threshold, err := parseDateOnly(referenceDate)
	if err != nil {
		return "", false
	}
	if billing.BillingCycle == "one-time" {
		if billing.OneTimeTermCount <= 0 || !isValidCustomCycleUnit(billing.OneTimeTermUnit) || !isValidDateOnly(billing.NextBillingDate) {
			return "", false
		}
		if anchor > billing.NextBillingDate || billing.NextBillingDate < referenceDate {
			return "", false
		}
		return billing.NextBillingDate, true
	}
	input := subscriptionRenewalInput{
		BillingCycle:    billing.BillingCycle,
		CustomDays:      billing.CustomDays,
		CustomCycleUnit: billing.CustomCycleUnit,
	}
	cycleCount := maxInt(1, initialCycleCount(anchorDate, input, threshold, false))
	for attempts := 0; attempts < maxAdvanceCycles; attempts++ {
		candidate, err := addBillingCyclesDate(anchorDate, billing.BillingCycle, cycleCount, billing.CustomDays, billing.CustomCycleUnit)
		if err != nil {
			return "", false
		}
		if !candidate.Before(threshold) {
			return formatDateOnly(candidate), true
		}
		cycleCount++
	}
	return "", false
}

func costSharingCollectionOneTimeBuyout(billing costSharingCollectionBilling) bool {
	return billing.BillingCycle == "one-time" && !(billing.OneTimeTermCount > 0 && isValidCustomCycleUnit(billing.OneTimeTermUnit))
}

func costSharingCollectionBillingFromRecord(record subscriptionRecordReader) costSharingCollectionBilling {
	return costSharingCollectionBilling{
		BillingCycle:     record.GetString("billingCycle"),
		CustomDays:       record.GetInt("customDays"),
		CustomCycleUnit:  record.GetString("customCycleUnit"),
		OneTimeTermCount: record.GetInt("oneTimeTermCount"),
		OneTimeTermUnit:  record.GetString("oneTimeTermUnit"),
		StartDate:        record.GetString("startDate"),
		NextBillingDate:  record.GetString("nextBillingDate"),
	}
}

func refreshCostSharingCollectionReminderMirrorsForUser(app core.App, userID string, settings appSettings, referenceDate string) error {
	if strings.TrimSpace(userID) == "" {
		return nil
	}
	for offset := 0; ; offset += subscriptionCleanupPageSize {
		rows, err := app.FindRecordsByFilter("subscriptions", "user = {:user}", "created", subscriptionCleanupPageSize, offset, dbx.Params{"user": userID})
		if err != nil {
			return err
		}
		for _, record := range rows {
			enabled, nextDate := costSharingCollectionReminderMirror(record.Get("costSharing"), costSharingCollectionBillingFromRecord(record), settings, referenceDate)
			if record.GetBool("costSharingCollectionReminderEnabled") == enabled &&
				record.GetString("costSharingNextCollectionReminderDate") == nextDate {
				continue
			}
			// settings 里的全局提醒天数/时区会影响 inherited 收款提醒；用户改设置时必须重算镜像，不能等 cron 扫 JSON。
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

func costSharingCollectionReminderReferenceDate(settings appSettings, now time.Time) string {
	return todayDateOnly(now.UTC(), settings.Timezone)
}
