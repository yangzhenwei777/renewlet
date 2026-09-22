package main

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

const (
	subscriptionCalendarFeedListDefaultLimit = 20
	subscriptionCalendarFeedListMaxLimit     = 50
)

type subscriptionCalendarFeedListSubscription struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Status          string `json:"status"`
	NextBillingDate string `json:"nextBillingDate"`
}

type subscriptionCalendarFeedListItem struct {
	ID           string                                   `json:"id"`
	FeedURL      string                                   `json:"feedUrl"`
	CreatedAt    string                                   `json:"createdAt"`
	UpdatedAt    string                                   `json:"updatedAt"`
	Subscription subscriptionCalendarFeedListSubscription `json:"subscription"`
}

type subscriptionCalendarFeedListPage struct {
	Items   []subscriptionCalendarFeedListItem `json:"items"`
	Limit   int                                `json:"limit"`
	Offset  int                                `json:"offset"`
	Total   int64                              `json:"total"`
	HasMore bool                               `json:"hasMore"`
}

type subscriptionCalendarFeedListResponse struct {
	CalendarFeeds subscriptionCalendarFeedListPage `json:"calendarFeeds"`
}

type subscriptionCalendarFeedListRow struct {
	ID                          string         `db:"id"`
	Token                       string         `db:"token"`
	Created                     types.DateTime `db:"created"`
	Updated                     types.DateTime `db:"updated"`
	SubscriptionID              string         `db:"subscription_id"`
	SubscriptionName            string         `db:"subscription_name"`
	SubscriptionStatus          string         `db:"subscription_status"`
	SubscriptionNextBillingDate string         `db:"subscription_next_billing_date"`
	Total                       int64          `db:"total"`
}

func handleSubscriptionCalendarFeedsList(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	limit, offset, err := parseSubscriptionCalendarFeedListQuery(e.Request.URL.Query())
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), err)
	}
	var rows []subscriptionCalendarFeedListRow
	// 单订阅 Feed 与订阅窄投影在同一 owner-scoped statement 中返回；总数和当前页共享筛选口径，不逐项回读订阅。
	err = app.DB().NewQuery(`WITH owned AS (
		SELECT
			f.id,
			f.token,
			f.created,
			f.updated,
			s.id AS subscription_id,
			s.name AS subscription_name,
			s.status AS subscription_status,
			s.nextBillingDate AS subscription_next_billing_date
		FROM calendar_feeds AS f
		JOIN subscriptions AS s
			ON s.id = f.subscriptionId AND s.user = f.user
		WHERE f.user = {:user} AND f.scope = 'subscription'
	), page AS (
		SELECT * FROM owned
		ORDER BY updated DESC, id DESC
		LIMIT {:limit} OFFSET {:offset}
	)
	SELECT
		COALESCE(page.id, '') AS id,
		COALESCE(page.token, '') AS token,
		COALESCE(page.created, '') AS created,
		COALESCE(page.updated, '') AS updated,
		COALESCE(page.subscription_id, '') AS subscription_id,
		COALESCE(page.subscription_name, '') AS subscription_name,
		COALESCE(page.subscription_status, '') AS subscription_status,
		COALESCE(page.subscription_next_billing_date, '') AS subscription_next_billing_date,
		counts.total AS total
	FROM (SELECT COUNT(*) AS total FROM owned) AS counts
	LEFT JOIN page ON 1 = 1
	ORDER BY page.updated DESC, page.id DESC`).
		Bind(dbx.Params{"user": e.Auth.Id, "limit": limit, "offset": offset}).
		All(&rows)
	if err != nil {
		return e.InternalServerError(serverText(locale, "calendarFeed.loadFailed"), err)
	}
	items := make([]subscriptionCalendarFeedListItem, 0, len(rows))
	var total int64
	for _, row := range rows {
		total = row.Total
		if row.ID == "" {
			continue
		}
		item := subscriptionCalendarFeedListItem{
			ID:        row.ID,
			FeedURL:   calendarFeedURL(e.Request, row.Token),
			CreatedAt: calendarFeedTimestamp(row.Created),
			UpdatedAt: calendarFeedTimestamp(row.Updated),
			Subscription: subscriptionCalendarFeedListSubscription{
				ID:              row.SubscriptionID,
				Name:            row.SubscriptionName,
				Status:          row.SubscriptionStatus,
				NextBillingDate: row.SubscriptionNextBillingDate,
			},
		}
		items = append(items, item)
	}
	return calendarFeedSuccessJSON(e, http.StatusOK, subscriptionCalendarFeedListResponse{CalendarFeeds: subscriptionCalendarFeedListPage{
		Items: items, Limit: limit, Offset: offset, Total: total, HasMore: int64(offset+len(items)) < total,
	}})
}

func handleCalendarFeedRotate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if _, err := decodeStrictJSON[calendarFeedCreateRequest](e.Request, locale); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	record, err := findGlobalCalendarFeedForUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "calendarFeed.loadFailed"), err)
	}
	if record == nil {
		return e.NotFoundError(serverText(locale, "calendarFeed.notFound"), nil)
	}
	return rotateCalendarFeedRecord(app, e, record)
}

func handleSubscriptionCalendarFeedRotate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if _, err := decodeStrictJSON[calendarFeedCreateRequest](e.Request, locale); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	subscriptionID := strings.TrimSpace(e.Request.PathValue("id"))
	subscription, err := findCalendarFeedSubscriptionByID(app, e.Auth.Id, subscriptionID)
	if err != nil || calendarFeedSubscriptionIsBuyout(subscription) {
		return e.NotFoundError(serverText(locale, "subscription.notFound"), err)
	}
	record, err := findSubscriptionCalendarFeedForUser(app, e.Auth.Id, subscriptionID)
	if err != nil {
		return e.InternalServerError(serverText(locale, "calendarFeed.loadFailed"), err)
	}
	if record == nil {
		return e.NotFoundError(serverText(locale, "calendarFeed.notFound"), nil)
	}
	return rotateCalendarFeedRecord(app, e, record)
}

func rotateCalendarFeedRecord(app core.App, e *core.RequestEvent, record *core.Record) error {
	locale := requestLocale(e.Request)
	token, err := newCalendarFeedToken()
	if err != nil {
		return e.InternalServerError(serverText(locale, "calendarFeed.createFailed"), err)
	}
	// 单条 UPDATE 是轮换的原子边界；不能先删除再创建，否则创建失败会让旧 URL 无法恢复。
	record.Set("token", token)
	if err := app.Save(record); err != nil {
		return e.InternalServerError(serverText(locale, "calendarFeed.createFailed"), err)
	}
	return calendarFeedSuccessJSON(e, http.StatusOK, calendarFeedCreateResponse{
		CalendarFeed: calendarFeedCreateStatusFromRecord(e.Request, record),
	})
}

func calendarFeedCreateStatusFromRecord(request *http.Request, record *core.Record) calendarFeedCreateStatus {
	return calendarFeedCreateStatus{
		Enabled:   true,
		CreatedAt: record.GetDateTime("created").Time().UTC().Format(time.RFC3339),
		UpdatedAt: record.GetDateTime("updated").Time().UTC().Format(time.RFC3339),
		FeedURL:   calendarFeedURL(request, record.GetString("token")),
	}
}

func calendarFeedSuccessJSON(e *core.RequestEvent, status int, data any) error {
	// 登录态响应含可复制 bearer URL 或改变其有效性，任何中间缓存都可能让撤销后的旧 token 再次出现。
	e.Response.Header().Set("Cache-Control", "no-store")
	return apiSuccessJSON(e, status, data)
}

func parseSubscriptionCalendarFeedListQuery(values url.Values) (int, int, error) {
	for key, entries := range values {
		if (key != "limit" && key != "offset") || len(entries) != 1 || strings.TrimSpace(entries[0]) == "" {
			return 0, 0, errors.New("invalid subscription calendar feed list query")
		}
	}
	limit, err := parsePositiveQueryInt(values.Get("limit"), subscriptionCalendarFeedListDefaultLimit, 1, subscriptionCalendarFeedListMaxLimit)
	if err != nil {
		return 0, 0, err
	}
	offset, err := parsePositiveQueryInt(values.Get("offset"), 0, 0, int(^uint(0)>>1))
	if err != nil {
		return 0, 0, err
	}
	return limit, offset, nil
}

func calendarFeedTimestamp(value types.DateTime) string {
	// PocketBase 持久层使用 DefaultDateLayout；管理 API 仍按现有 Feed 状态契约输出 RFC3339。
	return value.Time().UTC().Format(time.RFC3339)
}
