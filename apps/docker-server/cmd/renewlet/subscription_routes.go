package main

// subscription_routes.go 承载绕过 PocketBase SDK 形状的订阅专用 API。
//
// 这里输出前端稳定 DTO，并把手动续订限制在当前 owner、非自动续订、非 one-time 订阅上。
import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type subscriptionResponse struct {
	Subscription subscriptionDetailResponse `json:"subscription"`
}

type subscriptionDetailResponse struct {
	subscriptionCollectionItemResponse
	Website                *string                `json:"website,omitempty"`
	Notes                  *string                `json:"notes,omitempty"`
	Tags                   []string               `json:"tags"`
	RepeatReminderEnabled  bool                   `json:"repeatReminderEnabled"`
	RepeatReminderInterval string                 `json:"repeatReminderInterval"`
	RepeatReminderWindow   string                 `json:"repeatReminderWindow"`
	Extra                  map[string]interface{} `json:"extra"`
	CreatedAt              string                 `json:"createdAt,omitempty"`
	UpdatedAt              string                 `json:"updatedAt,omitempty"`
}

// handleSubscriptionRenew 按用户选择延续或重开当前订阅；Renewlet 只更新账本状态，不生成付款流水。
func handleSubscriptionRenew(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[subscriptionRenewRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	subscriptionID := strings.TrimSpace(e.Request.PathValue("id"))
	// 手动续订是认证用户的写入边界；查询同时带 id 和 user，避免通过错误码枚举他人订阅。
	record, err := app.FindFirstRecordByFilter(
		"subscriptions",
		"id = {:id} && user = {:user}",
		dbx.Params{"id": subscriptionID, "user": e.Auth.Id},
	)
	if err != nil || record == nil {
		return e.NotFoundError("SUBSCRIPTION_NOT_FOUND", err)
	}
	today := todayDateOnly(time.Now(), currentUserSettingsTimezone(app, e.Auth))
	input := subscriptionRenewalInputFromRecord(record)
	if !isManualRenewEligible(input) {
		return e.BadRequestError("SUBSCRIPTION_RENEW_NOT_ALLOWED", nil)
	}
	record.Set("price", body.Price)
	record.Set("currency", body.Currency)
	if body.Mode == "continue" {
		// continue 的日期字段只服务显式契约和前端预览；真正推进必须沿原订阅锚点，避免把续订误写成重开。
		result, ok, err := advanceSubscriptionRenewal(input, today, renewalModeManual)
		if err != nil {
			return e.BadRequestError(err.Error(), err)
		}
		if !ok {
			return e.BadRequestError("SUBSCRIPTION_RENEW_NOT_ALLOWED", nil)
		}
		record.Set("nextBillingDate", result.NextBillingDate)
		record.Set("status", result.Status)
	} else {
		// restart 改变开始日和收款周期边界；Save 会进入 PocketBase hook，重新校验日期、家庭共享镜像和派生状态。
		record.Set("startDate", body.StartDate.Value)
		record.Set("nextBillingDate", body.NextBillingDate)
		record.Set("autoCalculateNextBillingDate", body.AutoCalculateNextBillingDate)
		if record.GetString("status") == "expired" {
			record.Set("status", "active")
		}
	}
	if err := app.Save(record); err != nil {
		return e.BadRequestError("SUBSCRIPTION_RENEW_FAILED", err)
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionResponse{Subscription: subscriptionAPIFromRecord(record)})
}

func subscriptionAPIFromRecord(record *core.Record) subscriptionDetailResponse {
	out := subscriptionDetailResponse{
		subscriptionCollectionItemResponse: subscriptionCollectionAPIFromRecord(record),
		Website:                            trimmedSubscriptionString(record.GetString("website")),
		Notes:                              trimmedSubscriptionString(record.GetString("notes")),
		Tags:                               subscriptionRecordStringSlice(record, "tags"),
		RepeatReminderEnabled:              record.GetBool("repeatReminderEnabled"),
		RepeatReminderInterval:             normalizeRepeatReminderInterval(record.GetString("repeatReminderInterval")),
		RepeatReminderWindow:               normalizeRepeatReminderWindow(record.GetString("repeatReminderWindow")),
		Extra:                              subscriptionRecordJSONMap(record, "extra"),
	}
	if !record.GetDateTime("created").IsZero() {
		out.CreatedAt = record.GetDateTime("created").Time().UTC().Format(time.RFC3339Nano)
	}
	if !record.GetDateTime("updated").IsZero() {
		out.UpdatedAt = record.GetDateTime("updated").Time().UTC().Format(time.RFC3339Nano)
	}
	return out
}

func subscriptionRecordJSONMap(record *core.Record, name string) map[string]interface{} {
	data, err := jsonBytesFromValue(record.Get(name))
	if err != nil || len(data) == 0 {
		return map[string]interface{}{}
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(data, &decoded); err != nil || decoded == nil {
		return map[string]interface{}{}
	}
	return decoded
}

func currentUserSettingsTimezone(app core.App, user *core.Record) string {
	settings, err := currentUserSettings(app, user)
	if err != nil {
		return defaultAppSettings().Timezone
	}
	return settings.Timezone
}
