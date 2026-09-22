package main

// calendar_feed.go 管理外部日历订阅 feed。
//
// 架构位置：
//   - 登录态 API 负责查看、生成和撤销私有 URL。
//   - 公开 ICS route 不读登录态，只用订阅 URL token 定位用户、scope 和订阅数据。
//   - ICS 内容只导出 Renewlet 当前 nextBillingDate，不生成 RRULE，避免外部日历复刻业务日期算法。
import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	ics "github.com/arran4/golang-ical"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	calendarFeedScopeAll             = "all"
	calendarFeedScopeSubscription    = "subscription"
	calendarFeedSubscriptionPageSize = 500
	calendarFeedTokenBytes           = 32
)

type calendarFeedStatus struct {
	Enabled   bool   `json:"enabled"`
	CreatedAt string `json:"createdAt,omitempty"`
	FeedURL   string `json:"feedUrl,omitempty"`
	UpdatedAt string `json:"updatedAt,omitempty"`
}

type calendarFeedStatusResponse struct {
	CalendarFeed calendarFeedStatus `json:"calendarFeed"`
}

type calendarFeedCreateStatus struct {
	Enabled   bool   `json:"enabled"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	FeedURL   string `json:"feedUrl"`
}

type calendarFeedCreateResponse struct {
	CalendarFeed calendarFeedCreateStatus `json:"calendarFeed"`
}

type calendarFeedSubscription struct {
	ID               string
	Name             string
	Price            string
	Currency         string
	BillingCycle     string
	CustomDays       int
	CustomCycleUnit  string
	OneTimeTermCount int
	OneTimeTermUnit  string
	Category         string
	Status           string
	PaymentMethod    string
	NextBillingDate  string
	Website          string
	Notes            string
	ReminderDays     int
}

type calendarFeedEvent struct {
	UID          string
	Kind         string
	Date         string
	Summary      string
	Description  string
	Category     string
	URL          string
	ReminderDays *int
}

type calendarFeedLabelResolver struct {
	locale               appLocale
	categoryByValue      map[string]string
	paymentMethodByValue map[string]string
}

type calendarFeedBuiltInLabelKeyResolver func(string) (string, bool)

func handleCalendarFeedStatus(app core.App, e *core.RequestEvent) error {
	record, err := findGlobalCalendarFeedForUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "calendarFeed.loadFailed"), err)
	}
	return calendarFeedSuccessJSON(e, http.StatusOK, calendarFeedStatusResponse{CalendarFeed: calendarFeedStatusFromRecord(e.Request, record)})
}

func handleCalendarFeedCreate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if _, err := decodeStrictJSON[calendarFeedCreateRequest](e.Request, locale); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	record, err := ensureGlobalCalendarFeed(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "calendarFeed.createFailed"), err)
	}
	return calendarFeedSuccessJSON(e, http.StatusOK, calendarFeedCreateResponse{CalendarFeed: calendarFeedCreateStatusFromRecord(e.Request, record)})
}

func handleCalendarFeedDelete(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	record, err := findGlobalCalendarFeedForUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "calendarFeed.revokeFailed"), err)
	}
	if record == nil {
		return e.NotFoundError(serverText(locale, "calendarFeed.notFound"), nil)
	}
	if err := app.Delete(record); err != nil {
		return e.InternalServerError(serverText(locale, "calendarFeed.revokeFailed"), err)
	}
	return calendarFeedSuccessJSON(e, http.StatusOK, nil)
}

func handleSubscriptionCalendarFeedStatus(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	subscriptionID := strings.TrimSpace(e.Request.PathValue("id"))
	subscription, err := findCalendarFeedSubscriptionByID(app, e.Auth.Id, subscriptionID)
	if err != nil || calendarFeedSubscriptionIsBuyout(subscription) {
		return e.NotFoundError(serverText(locale, "subscription.notFound"), err)
	}
	record, err := findSubscriptionCalendarFeedForUser(app, e.Auth.Id, subscriptionID)
	if err != nil {
		return e.InternalServerError(serverText(locale, "calendarFeed.loadFailed"), err)
	}
	return calendarFeedSuccessJSON(e, http.StatusOK, calendarFeedStatusResponse{CalendarFeed: calendarFeedStatusFromRecord(e.Request, record)})
}

func handleSubscriptionCalendarFeedCreate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	subscriptionID := strings.TrimSpace(e.Request.PathValue("id"))
	if _, err := decodeStrictJSON[calendarFeedCreateRequest](e.Request, locale); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	subscription, err := findCalendarFeedSubscriptionByID(app, e.Auth.Id, subscriptionID)
	if err != nil || calendarFeedSubscriptionIsBuyout(subscription) {
		return e.NotFoundError(serverText(locale, "subscription.notFound"), err)
	}
	record, err := ensureSubscriptionCalendarFeed(app, e.Auth.Id, subscriptionID)
	if err != nil {
		return e.InternalServerError(serverText(locale, "calendarFeed.createFailed"), err)
	}
	return calendarFeedSuccessJSON(e, http.StatusOK, calendarFeedCreateResponse{CalendarFeed: calendarFeedCreateStatusFromRecord(e.Request, record)})
}

func handleSubscriptionCalendarFeedDelete(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	subscriptionID := strings.TrimSpace(e.Request.PathValue("id"))
	if _, err := findCalendarFeedSubscriptionByID(app, e.Auth.Id, subscriptionID); err != nil {
		return e.NotFoundError(serverText(locale, "subscription.notFound"), err)
	}
	record, err := findSubscriptionCalendarFeedForUser(app, e.Auth.Id, subscriptionID)
	if err != nil {
		return e.InternalServerError(serverText(locale, "calendarFeed.revokeFailed"), err)
	}
	if record == nil {
		return e.NotFoundError(serverText(locale, "calendarFeed.notFound"), nil)
	}
	if err := app.Delete(record); err != nil {
		return e.InternalServerError(serverText(locale, "calendarFeed.revokeFailed"), err)
	}
	return calendarFeedSuccessJSON(e, http.StatusOK, nil)
}

func handleSubscriptionCalendarICSDownload(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	subscriptionID := strings.TrimSpace(e.Request.PathValue("id"))
	subscription, err := findCalendarFeedSubscriptionByID(app, e.Auth.Id, subscriptionID)
	if err != nil || calendarFeedSubscriptionIsBuyout(subscription) {
		return e.NotFoundError(serverText(locale, "subscription.notFound"), err)
	}
	body, err := renderSubscriptionCalendarICSDownload(app, e.Auth.Id, subscription)
	if err != nil {
		return e.InternalServerError(serverText(locale, "calendarFeed.renderFailed"), err)
	}
	headers := e.Response.Header()
	headers.Set("Content-Type", "text/calendar; charset=utf-8")
	headers.Set("Content-Disposition", fmt.Sprintf(`attachment; filename="renewlet-%s.ics"`, safeCalendarFeedFilename(subscription.ID)))
	headers.Set("Cache-Control", "no-store")
	headers.Set("X-Content-Type-Options", "nosniff")
	e.Response.WriteHeader(http.StatusOK)
	_, writeErr := e.Response.Write([]byte(body))
	return writeErr
}

func handleCalendarFeedICS(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	token := strings.TrimSpace(e.Request.URL.Query().Get("token"))
	if token == "" {
		return e.NotFoundError(serverText(locale, "calendarFeed.notFound"), nil)
	}
	feed, err := app.FindFirstRecordByFilter("calendar_feeds", "token = {:token}", dbx.Params{"token": token})
	if err != nil {
		// 公开 feed 是 bearer URL；对缺失、撤销和猜测 token 一律 404，避免暴露 token 是否接近有效。
		return e.NotFoundError(serverText(locale, "calendarFeed.notFound"), nil)
	}
	body, filename, err := renderCalendarFeedICS(app, e.Request, feed)
	if err != nil {
		if errorsIsNoRows(err) {
			return e.NotFoundError(serverText(locale, "calendarFeed.notFound"), err)
		}
		return e.InternalServerError(serverText(locale, "calendarFeed.renderFailed"), err)
	}
	headers := e.Response.Header()
	headers.Set("Content-Type", "text/calendar; charset=utf-8")
	headers.Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, filename))
	headers.Set("Cache-Control", "private, max-age=300")
	headers.Set("X-Content-Type-Options", "nosniff")
	e.Response.WriteHeader(http.StatusOK)
	_, writeErr := e.Response.Write([]byte(body))
	return writeErr
}

func renderCalendarFeedICS(app core.App, request *http.Request, feed *core.Record) (string, string, error) {
	userID := feed.GetString("user")
	settings, err := calendarFeedSettingsForUser(app, userID)
	if err != nil {
		return "", "", err
	}
	labels, err := newCalendarFeedLabelResolver(app, userID, settings)
	if err != nil {
		return "", "", err
	}
	sourceURL := calendarFeedURL(request, feed.GetString("token"))
	// 日历客户端的请求语言不稳定且没有账号会话；Feed 内容必须始终由 owner 的账号内容语言决定。
	contentLocale := accountContentLocale(settings)
	switch feed.GetString("scope") {
	case calendarFeedScopeSubscription:
		subscription, err := findCalendarFeedSubscriptionByID(app, userID, feed.GetString("subscriptionId"))
		if err != nil {
			return "", "", err
		}
		body := buildCalendarFeedICS(calendarFeedBuildOptions{
			Name:              serverFormat(contentLocale, "calendarFeed.subscriptionCalendarName", map[string]interface{}{"name": subscription.Name}),
			SourceURL:         sourceURL,
			Now:               time.Now().UTC(),
			Settings:          settings,
			Events:            subscriptionCalendarFeedEvents(subscription, settings, labels),
			RefreshableSource: true,
		})
		return body, "renewlet-subscription.ics", nil
	case calendarFeedScopeAll:
		subscriptions, err := listCalendarFeedSubscriptions(app, userID)
		if err != nil {
			return "", "", err
		}
		body := buildCalendarFeedICS(calendarFeedBuildOptions{
			Name:              serverText(contentLocale, "calendarFeed.calendarName"),
			SourceURL:         sourceURL,
			Now:               time.Now().UTC(),
			Settings:          settings,
			Events:            globalCalendarFeedEvents(subscriptions, settings, time.Now().UTC(), labels),
			RefreshableSource: true,
		})
		return body, "renewlet-renewals.ics", nil
	default:
		return "", "", sql.ErrNoRows
	}
}

func renderSubscriptionCalendarICSDownload(app core.App, userID string, subscription calendarFeedSubscription) (string, error) {
	settings, err := calendarFeedSettingsForUser(app, userID)
	if err != nil {
		return "", err
	}
	labels, err := newCalendarFeedLabelResolver(app, userID, settings)
	if err != nil {
		return "", err
	}
	// 一次性 .ics 进入外部日历后脱离当前请求，因此沿用账号内容语言，且不写 SOURCE/TTL。
	return buildCalendarFeedICS(calendarFeedBuildOptions{
		Name:              serverFormat(accountContentLocale(settings), "calendarFeed.subscriptionCalendarName", map[string]interface{}{"name": subscription.Name}),
		Now:               time.Now().UTC(),
		Settings:          settings,
		Events:            subscriptionCalendarFeedEvents(subscription, settings, labels),
		RefreshableSource: false,
	}), nil
}

func findGlobalCalendarFeedForUser(app core.App, userID string) (*core.Record, error) {
	record, err := app.FindFirstRecordByFilter(
		"calendar_feeds",
		"user = {:user} && scope = {:scope}",
		dbx.Params{"user": userID, "scope": calendarFeedScopeAll},
	)
	if err != nil {
		if errorsIsNoRows(err) {
			return nil, nil
		}
		return nil, err
	}
	return record, nil
}

func findSubscriptionCalendarFeedForUser(app core.App, userID string, subscriptionID string) (*core.Record, error) {
	records, err := app.FindRecordsByFilter(
		"calendar_feeds",
		"user = {:user} && scope = {:scope} && subscriptionId = {:subscriptionId}",
		"-created",
		1,
		0,
		dbx.Params{"user": userID, "scope": calendarFeedScopeSubscription, "subscriptionId": subscriptionID},
	)
	if err != nil {
		return nil, err
	}
	if len(records) == 0 {
		return nil, nil
	}
	return records[0], nil
}

func calendarFeedSettingsForUser(app core.App, userID string) (appSettings, error) {
	settings := defaultAppSettings()
	record, err := app.FindFirstRecordByFilter("settings", "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		if errorsIsNoRows(err) {
			return settings, nil
		}
		return settings, err
	}
	return settingsFromRecord(record)
}

func errorsIsNoRows(err error) bool {
	return err == sql.ErrNoRows || strings.Contains(err.Error(), "no rows")
}

func ensureGlobalCalendarFeed(app core.App, userID string) (*core.Record, error) {
	collection, err := app.FindCollectionByNameOrId("calendar_feeds")
	if err != nil {
		return nil, err
	}
	record, err := findGlobalCalendarFeedForUser(app, userID)
	if err != nil {
		return nil, err
	}
	if record == nil {
		record = core.NewRecord(collection)
		record.Set("user", userID)
		token, err := newCalendarFeedToken()
		if err != nil {
			return nil, err
		}
		record.Set("token", token)
	}
	record.Set("scope", calendarFeedScopeAll)
	record.Set("subscriptionId", "")
	if err := app.Save(record); err != nil {
		return nil, err
	}
	return record, nil
}

func ensureSubscriptionCalendarFeed(app core.App, userID string, subscriptionID string) (*core.Record, error) {
	collection, err := app.FindCollectionByNameOrId("calendar_feeds")
	if err != nil {
		return nil, err
	}
	record, err := findSubscriptionCalendarFeedForUser(app, userID, subscriptionID)
	if err != nil {
		return nil, err
	}
	if record != nil {
		return record, nil
	}
	token, err := newCalendarFeedToken()
	if err != nil {
		return nil, err
	}
	record = core.NewRecord(collection)
	record.Set("user", userID)
	record.Set("scope", calendarFeedScopeSubscription)
	record.Set("subscriptionId", subscriptionID)
	record.Set("token", token)
	if err := app.Save(record); err != nil {
		return nil, err
	}
	return record, nil
}

func deleteSubscriptionCalendarFeeds(app core.App, userID string, subscriptionID string) error {
	_, err := app.DB().NewQuery(`DELETE FROM calendar_feeds
		WHERE user = {:user} AND scope = {:scope} AND subscriptionId = {:subscriptionId}`).
		Bind(dbx.Params{"user": userID, "scope": calendarFeedScopeSubscription, "subscriptionId": subscriptionID}).
		Execute()
	return err
}

func calendarFeedStatusFromRecord(request *http.Request, record *core.Record) calendarFeedStatus {
	if record == nil {
		return calendarFeedStatus{Enabled: false}
	}
	return calendarFeedStatus{
		Enabled:   true,
		CreatedAt: record.GetDateTime("created").Time().UTC().Format(time.RFC3339),
		FeedURL:   calendarFeedURL(request, record.GetString("token")),
		UpdatedAt: record.GetDateTime("updated").Time().UTC().Format(time.RFC3339),
	}
}

func newCalendarFeedToken() (string, error) {
	data := make([]byte, calendarFeedTokenBytes)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}

func calendarFeedURL(request *http.Request, token string) string {
	return externalRequestURL(request, "/calendar/renewals.ics", url.Values{"token": []string{token}})
}

func listCalendarFeedSubscriptions(app core.App, userID string) ([]calendarFeedSubscription, error) {
	items := []calendarFeedSubscription{}
	for offset := 0; ; offset += calendarFeedSubscriptionPageSize {
		rows, err := app.FindRecordsByFilter("subscriptions", "user = {:user}", "nextBillingDate,name", calendarFeedSubscriptionPageSize, offset, dbx.Params{"user": userID})
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			items = append(items, calendarFeedSubscriptionFromRecord(row))
		}
		if len(rows) < calendarFeedSubscriptionPageSize {
			return items, nil
		}
	}
}

func findCalendarFeedSubscriptionByID(app core.App, userID string, subscriptionID string) (calendarFeedSubscription, error) {
	row, err := app.FindFirstRecordByFilter("subscriptions", "id = {:id} && user = {:user}", dbx.Params{"id": subscriptionID, "user": userID})
	if err != nil {
		return calendarFeedSubscription{}, err
	}
	return calendarFeedSubscriptionFromRecord(row), nil
}

func calendarFeedSubscriptionFromRecord(row *core.Record) calendarFeedSubscription {
	return calendarFeedSubscription{
		ID:               row.Id,
		Name:             row.GetString("name"),
		Price:            moneyForRecord(row.Get("price")),
		Currency:         row.GetString("currency"),
		BillingCycle:     row.GetString("billingCycle"),
		CustomDays:       row.GetInt("customDays"),
		CustomCycleUnit:  row.GetString("customCycleUnit"),
		OneTimeTermCount: row.GetInt("oneTimeTermCount"),
		OneTimeTermUnit:  row.GetString("oneTimeTermUnit"),
		Category:         row.GetString("category"),
		Status:           row.GetString("status"),
		PaymentMethod:    row.GetString("paymentMethod"),
		NextBillingDate:  row.GetString("nextBillingDate"),
		Website:          row.GetString("website"),
		Notes:            row.GetString("notes"),
		ReminderDays:     row.GetInt("reminderDays"),
	}
}

func newCalendarFeedLabelResolver(app core.App, userID string, settings appSettings) (calendarFeedLabelResolver, error) {
	resolver := calendarFeedLabelResolver{
		locale:               accountContentLocale(settings),
		categoryByValue:      map[string]string{},
		paymentMethodByValue: map[string]string{},
	}
	record, err := app.FindFirstRecordByFilter("custom_configs", "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		if errorsIsNoRows(err) {
			return resolver, nil
		}
		return resolver, err
	}
	config, err := customConfigFromValue(record.Get("config"))
	if err != nil {
		return resolver, err
	}
	// 公开 ICS route 没有登录态上下文；用户配置只做优先查找，缺失的内置项回 server i18n，未知自定义 value 保留原文。
	resolver.categoryByValue = calendarFeedLabelMap(config.Categories, resolver.locale)
	resolver.paymentMethodByValue = calendarFeedLabelMap(config.PaymentMethods, resolver.locale)
	return resolver, nil
}

func calendarFeedLabelMap(items []customConfigItem, locale appLocale) map[string]string {
	labels := make(map[string]string, len(items))
	for _, item := range items {
		if item.Value == "" {
			continue
		}
		if label := calendarFeedLocalizedConfigLabel(item.Labels, locale); label != "" {
			labels[item.Value] = label
		}
	}
	return labels
}

func calendarFeedLocalizedConfigLabel(labels customConfigLabels, locale appLocale) string {
	if locale == localeEnUS {
		if labels.EnUS != "" {
			return labels.EnUS
		}
		if labels.ZhCN != "" {
			return labels.ZhCN
		}
		return ""
	}
	if labels.ZhCN != "" {
		return labels.ZhCN
	}
	if labels.EnUS != "" {
		return labels.EnUS
	}
	return ""
}

func (resolver calendarFeedLabelResolver) categoryLabel(value string) string {
	return resolver.resolvedLabel(resolver.categoryByValue, calendarFeedBuiltInCategoryLabelKey, value)
}

func (resolver calendarFeedLabelResolver) paymentMethodLabel(value string) string {
	return resolver.resolvedLabel(resolver.paymentMethodByValue, calendarFeedBuiltInPaymentMethodLabelKey, value)
}

func (resolver calendarFeedLabelResolver) resolvedLabel(customLabels map[string]string, builtInLabelKey calendarFeedBuiltInLabelKeyResolver, value string) string {
	if label, ok := customLabels[value]; ok && label != "" {
		return label
	}
	if key, ok := builtInLabelKey(value); ok {
		return serverText(resolver.locale, key)
	}
	return value
}

func calendarFeedBuiltInCategoryLabelKey(value string) (string, bool) {
	key, ok := calendarFeedBuiltInCategoryLabelKeys[value]
	return key, ok
}

func calendarFeedBuiltInPaymentMethodLabelKey(value string) (string, bool) {
	key, ok := calendarFeedBuiltInPaymentMethodLabelKeys[value]
	return key, ok
}

type calendarFeedBuildOptions struct {
	Name              string
	SourceURL         string
	Now               time.Time
	Settings          appSettings
	Events            []calendarFeedEvent
	RefreshableSource bool
}

func buildCalendarFeedICS(options calendarFeedBuildOptions) string {
	locale := accountContentLocale(options.Settings)
	events := options.Events
	cal := ics.NewCalendar()
	cal.SetProductId("-//Renewlet//Renewal Calendar//EN")
	cal.SetCalscale("GREGORIAN")
	cal.SetMethod(ics.MethodPublish)
	cal.SetName(options.Name)
	if options.RefreshableSource {
		cal.SetRefreshInterval("PT1H")
		cal.SetXPublishedTTL("PT1H")
		addCalendarFeedSource(cal, options.SourceURL)
	}
	for _, event := range events {
		start, err := time.Parse("2006-01-02", event.Date)
		if err != nil {
			continue
		}
		vevent := cal.AddEvent(event.UID)
		vevent.SetDtStampTime(options.Now.UTC())
		// ICS 只表达 Renewlet 已计算出的 date-only 下一次续费；不生成 RRULE，避免外部日历与 nextBillingDate 事实源漂移。
		vevent.SetAllDayStartAt(start)
		vevent.SetAllDayEndAt(start.AddDate(0, 0, 1))
		vevent.SetSummary(event.Summary)
		vevent.SetDescription(event.Description)
		if event.Category != "" {
			vevent.AddCategory(event.Category)
		}
		if event.URL != "" {
			vevent.SetURL(event.URL)
		}
		if event.ReminderDays != nil {
			// “不提醒”只关闭日历闹钟，VEVENT 仍保留续费/到期事实，避免日历订阅丢失账期可见性。
			alarm := vevent.AddAlarm()
			alarm.SetAction(ics.ActionDisplay)
			alarm.SetDescription(calendarFeedAlarmDescription(event, locale))
			alarm.SetTrigger(calendarFeedAlarmTrigger(*event.ReminderDays))
		}
	}
	return normalizeCalendarFeedLineEndings(cal.Serialize())
}

func normalizeCalendarFeedLineEndings(value string) string {
	// RFC 5545 要求 content line 使用 CRLF；macOS 订阅解析比本地 .ics 导入更严格，不能依赖库输出的裸 LF。
	normalized := strings.ReplaceAll(value, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	return strings.ReplaceAll(normalized, "\n", "\r\n")
}

func globalCalendarFeedEvents(items []calendarFeedSubscription, settings appSettings, now time.Time, labels calendarFeedLabelResolver) []calendarFeedEvent {
	localDate := todayDateOnly(now, settings.Timezone)
	events := []calendarFeedEvent{}
	for _, item := range items {
		if (item.Status != "active" && item.Status != "trial") || calendarFeedSubscriptionIsBuyout(item) {
			continue
		}
		if !isValidDateOnly(item.NextBillingDate) || item.NextBillingDate < localDate {
			continue
		}
		events = append(events, calendarFeedEventFromSubscription(item, settings, labels))
	}
	sort.Slice(events, func(i, j int) bool {
		if events[i].Date == events[j].Date {
			return events[i].Summary < events[j].Summary
		}
		return events[i].Date < events[j].Date
	})
	return events
}

func subscriptionCalendarFeedEvents(item calendarFeedSubscription, settings appSettings, labels calendarFeedLabelResolver) []calendarFeedEvent {
	if calendarFeedSubscriptionIsBuyout(item) {
		return []calendarFeedEvent{}
	}
	if !isValidDateOnly(item.NextBillingDate) {
		return []calendarFeedEvent{}
	}
	return []calendarFeedEvent{calendarFeedEventFromSubscription(item, settings, labels)}
}

func calendarFeedSubscriptionIsBuyout(item calendarFeedSubscription) bool {
	return item.BillingCycle == "one-time" && item.OneTimeTermCount <= 0
}

func calendarFeedEventFromSubscription(item calendarFeedSubscription, settings appSettings, labels calendarFeedLabelResolver) calendarFeedEvent {
	categoryLabel := labels.categoryLabel(item.Category)
	kind := calendarFeedEventKind(item)
	return calendarFeedEvent{
		UID:          "renewlet-" + kind + "-" + item.ID + "@renewlet",
		Kind:         kind,
		Date:         item.NextBillingDate,
		Summary:      item.Name,
		Description:  calendarFeedDescription(item, settings, labels),
		Category:     categoryLabel,
		URL:          item.Website,
		ReminderDays: effectiveCalendarFeedReminderDays(item.ReminderDays, settings),
	}
}

func calendarFeedEventKind(item calendarFeedSubscription) string {
	if item.BillingCycle == "one-time" {
		return "expiry"
	}
	return "renewal"
}

func calendarFeedAlarmDescription(event calendarFeedEvent, locale appLocale) string {
	key := "calendarFeed.alarmDescription"
	if event.Kind == "expiry" {
		key = "calendarFeed.alarmExpiryDescription"
	}
	return serverFormat(locale, key, map[string]interface{}{"name": event.Summary})
}

func calendarFeedDescription(item calendarFeedSubscription, settings appSettings, labels calendarFeedLabelResolver) string {
	locale := accountContentLocale(settings)
	lines := []string{
		serverFormat(locale, "calendarFeed.description.amount", map[string]interface{}{"amount": formatAmount(item.Price), "currency": item.Currency}),
		serverFormat(locale, "calendarFeed.description.billingCycle", map[string]interface{}{"cycle": calendarFeedBillingCycleLabel(item, locale)}),
		serverFormat(locale, "calendarFeed.description.category", map[string]interface{}{"category": labels.categoryLabel(item.Category)}),
	}
	if item.PaymentMethod != "" {
		lines = append(lines, serverFormat(locale, "calendarFeed.description.paymentMethod", map[string]interface{}{"paymentMethod": labels.paymentMethodLabel(item.PaymentMethod)}))
	}
	if strings.TrimSpace(item.Notes) != "" {
		lines = append(lines, serverFormat(locale, "calendarFeed.description.notes", map[string]interface{}{"notes": strings.TrimSpace(item.Notes)}))
	}
	return strings.Join(lines, "\n")
}

func calendarFeedBillingCycleLabel(item calendarFeedSubscription, locale appLocale) string {
	if item.BillingCycle == "custom" {
		unit := item.CustomCycleUnit
		unitLabel := serverText(locale, "calendarFeed.customCycleUnit."+unit)
		if unitLabel == "calendarFeed.customCycleUnit."+unit {
			unitLabel = unit
		}
		return serverFormat(locale, "calendarFeed.billingCycle.customValue", map[string]interface{}{"count": item.CustomDays, "unit": unitLabel})
	}
	key := "calendarFeed.billingCycle." + item.BillingCycle
	label := serverText(locale, key)
	if label == key {
		return item.BillingCycle
	}
	return label
}

func effectiveCalendarFeedReminderDays(reminderDays int, settings appSettings) *int {
	if reminderDays == disabledReminderDays {
		return nil
	}
	value := reminderDays
	if reminderDays == inheritReminderDays {
		value = normalizeNotificationReminderDays(settings.NotificationReminderDays)
		return &value
	}
	if reminderDays < 0 || reminderDays > maxReminderDays {
		value = defaultNotificationReminderDays
		return &value
	}
	return &value
}

func calendarFeedAlarmTrigger(days int) string {
	if days <= 0 {
		return "PT0S"
	}
	return fmt.Sprintf("-P%dD", days)
}

func addCalendarFeedSource(cal *ics.Calendar, sourceURL string) {
	if strings.TrimSpace(sourceURL) == "" {
		return
	}
	// golang-ical 暂未暴露 RFC 7986 SOURCE setter；这里只补订阅刷新源，不回退到 URL 以免和事件官网含义混用。
	cal.CalendarProperties = append(cal.CalendarProperties, ics.CalendarProperty{
		BaseProperty: ics.BaseProperty{
			IANAToken:      "SOURCE",
			ICalParameters: map[string][]string{"VALUE": {string(ics.ValueDataTypeUri)}},
			Value:          sourceURL,
		},
	})
}

func safeCalendarFeedFilename(value string) string {
	name := strings.TrimSpace(value)
	if name == "" {
		return "subscription"
	}
	var builder strings.Builder
	for _, char := range name {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_' {
			builder.WriteRune(char)
		}
	}
	if builder.Len() == 0 {
		return "subscription"
	}
	return builder.String()
}
