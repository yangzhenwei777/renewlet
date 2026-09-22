package main

// telegram_bot.go 实现 Telegram Bot 查询命令 adapter。
//
// 架构位置：
//   - 登录态 `/api/app/telegram-bot/commands` 只管理 Bot 命令安装生命周期。
//   - Webhook `/api/telegram/webhook/{bindingId}` 不读取 session，只信任 Telegram secret header。
//   - 命令查询复用 Public API owner-scoped service，不直接读 subscriptions 表拼业务结果。
import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	telegramWebhookSecretBytes      = 32
	telegramWebhookSecretHeader     = "X-Telegram-Bot-Api-Secret-Token"
	telegramWebhookUpdateBodyMax    = 1 << 20
	telegramBotCommandDueDefault    = 30
	telegramBotCommandDueMax        = 366
	telegramBotCommandListLimit     = 10
	telegramBotAPIMethodSetWebhook  = "setWebhook"
	telegramBotAPIMethodDeleteHook  = "deleteWebhook"
	telegramBotAPIMethodSetCommands = "setMyCommands"
	telegramBotAPIMethodDelCommands = "deleteMyCommands"
	telegramBotAPIMethodSendMessage = "sendMessage"
)

var telegramBotPostJSON = defaultTelegramBotPostJSON

type telegramBotCommandsResponse struct {
	ConfigComplete bool    `json:"configComplete"`
	Installed      bool    `json:"installed"`
	Status         string  `json:"status"`
	ChatID         *string `json:"chatId"`
	InstalledAt    *string `json:"installedAt"`
	LastUsedAt     *string `json:"lastUsedAt"`
}

type telegramBotCommand struct {
	Command     string `json:"command"`
	Description string `json:"description"`
}

type telegramBotCommandScopeChat struct {
	Type   string `json:"type"`
	ChatID string `json:"chat_id"`
}

type telegramBotSetWebhookRequest struct {
	URL                string   `json:"url"`
	AllowedUpdates     []string `json:"allowed_updates"`
	DropPendingUpdates bool     `json:"drop_pending_updates"`
	MaxConnections     int      `json:"max_connections"`
	SecretToken        string   `json:"secret_token"`
}

type telegramBotDeleteWebhookRequest struct {
	DropPendingUpdates bool `json:"drop_pending_updates"`
}

type telegramBotSetMyCommandsRequest struct {
	Commands []telegramBotCommand        `json:"commands"`
	Scope    telegramBotCommandScopeChat `json:"scope"`
}

type telegramBotDeleteMyCommandsRequest struct {
	Scope telegramBotCommandScopeChat `json:"scope"`
}

type telegramWebhookUpdate struct {
	UpdateID *int64                  `json:"update_id"`
	Message  *telegramWebhookMessage `json:"message"`
}

type telegramWebhookMessage struct {
	Chat telegramWebhookChat `json:"chat"`
	Text string              `json:"text"`
}

type telegramWebhookChat struct {
	ID telegramChatID `json:"id"`
}

type telegramChatID string

func handleTelegramBotCommandsStatus(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	_, settings, err := settingsRecordOrDefault(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	binding, err := findTelegramBotBindingForUser(app, e.Auth.Id)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	setPublicAPIHeaders(e.Response.Header())
	return apiSuccessJSON(e, http.StatusOK, telegramBotCommandsDTO(settings, binding))
}

func handleTelegramBotCommandsInstall(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := requireEmptyRequestBody(e.Request); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	origin, err := telegramBotExternalOrigin(e.Request)
	if err != nil || origin.Scheme != "https" {
		return telegramBotBadRequest(e, "TELEGRAM_BOT_HTTPS_REQUIRED", serverText(locale, "common.invalidRequestParameters"), err)
	}
	_, settings, err := settingsRecordOrDefault(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	botToken, chatID, ok := telegramBotSavedConfig(settings)
	if !ok {
		return telegramBotBadRequest(e, "TELEGRAM_BOT_CONFIG_INCOMPLETE", serverText(locale, "common.invalidRequestParameters"), nil)
	}

	collection, err := app.FindCollectionByNameOrId("telegram_bot_bindings")
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	binding, err := findTelegramBotBindingForUser(app, e.Auth.Id)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	if binding != nil && binding.GetString("status") == "installed" && !telegramBotBindingMatchesSettings(binding, settings) {
		return telegramBotBadRequest(e, "TELEGRAM_BOT_INSTALLED_SETTINGS_LOCKED", serverText(locale, "common.invalidRequestParameters"), nil)
	}
	if binding == nil {
		binding = core.NewRecord(collection)
		binding.Set("user", e.Auth.Id)
	}
	secret, err := newTelegramWebhookSecret()
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	binding.Set("chatId", chatID)
	binding.Set("botTokenHash", hashTelegramSecret(botToken))
	// Webhook secret 明文只发给 Telegram setWebhook；本地只保存 hash，用 header 入站时重新计算比对。
	binding.Set("webhookSecretHash", hashTelegramSecret(secret))
	binding.Set("status", "installing")
	binding.Set("lastUpdateId", 0)
	binding.Set("lastUsedAt", "")
	if err := app.Save(binding); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}

	webhookURL := telegramBotWebhookURL(origin, binding.Id)
	// Telegram 菜单和后续 Bot 对话没有浏览器设备上下文，只能使用账号内容语言。
	telegramLocale := accountContentLocale(settings)
	if err := telegramBotInstallRemote(botToken, chatID, webhookURL, secret, telegramLocale); err != nil {
		telegramBotBestEffortRemoteCleanup(botToken, chatID, locale)
		_ = app.Delete(binding)
		return telegramBotUpstreamError(e, err)
	}
	binding.Set("status", "installed")
	if err := app.Save(binding); err != nil {
		telegramBotBestEffortRemoteCleanup(botToken, chatID, locale)
		_ = app.Delete(binding)
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	reloaded, _ := findTelegramBotBindingForUser(app, e.Auth.Id)
	setPublicAPIHeaders(e.Response.Header())
	return apiSuccessJSON(e, http.StatusOK, telegramBotCommandsDTO(settings, reloaded))
}

func handleTelegramBotCommandsDelete(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if err := requireEmptyRequestBody(e.Request); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	binding, err := findTelegramBotBindingForUser(app, e.Auth.Id)
	if err != nil {
		return e.NotFoundError(serverText(locale, "common.notFound"), err)
	}
	_, settings, err := settingsRecordOrDefault(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	botToken, chatID, ok := telegramBotSavedConfig(settings)
	if !ok {
		return telegramBotBadRequest(e, "TELEGRAM_BOT_CONFIG_INCOMPLETE", serverText(locale, "common.invalidRequestParameters"), nil)
	}
	if err := telegramBotDeleteRemote(botToken, chatID, locale); err != nil {
		return telegramBotUpstreamError(e, err)
	}
	if err := app.Delete(binding); err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	setPublicAPIHeaders(e.Response.Header())
	return apiEmptySuccessJSON(e, http.StatusOK)
}

func handleTelegramWebhook(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	bindingID := strings.TrimSpace(e.Request.PathValue("bindingId"))
	binding, err := app.FindRecordById("telegram_bot_bindings", bindingID)
	if err != nil {
		return e.NotFoundError(serverText(locale, "common.notFound"), err)
	}
	if !telegramWebhookSecretMatches(binding, e.Request.Header.Get(telegramWebhookSecretHeader)) {
		return apiErrorJSON(e, http.StatusUnauthorized, "TELEGRAM_WEBHOOK_UNAUTHORIZED", serverText(locale, "auth.loginRequired"), nil)
	}
	if binding.GetString("status") != "installed" {
		return telegramWebhookOK(e)
	}
	update, err := readTelegramWebhookUpdate(e.Request.Body)
	if err != nil || update.UpdateID == nil {
		return telegramWebhookOK(e)
	}
	updateID := *update.UpdateID
	if updateID <= int64(binding.GetInt("lastUpdateId")) {
		return telegramWebhookOK(e)
	}
	if update.Message == nil || strings.TrimSpace(string(update.Message.Chat.ID)) != strings.TrimSpace(binding.GetString("chatId")) {
		return telegramWebhookOK(e)
	}
	command, arg, ok := parseTelegramCommand(update.Message.Text)
	if !ok {
		return telegramWebhookOK(e)
	}
	userID := binding.GetString("user")
	// 只有目标 chat 的真实命令才读取 settings；foreign chat/非命令 no-op 不推进 update，避免低价值写入掩盖后续合法命令。
	_, settings, err := settingsRecordOrDefault(app, userID)
	if err != nil || !telegramBotBindingMatchesSettings(binding, settings) {
		return telegramWebhookOK(e)
	}
	// Webhook 的 Accept-Language 来自 Telegram 基础设施，不能覆盖 owner 的账号偏好。
	telegramLocale := accountContentLocale(settings)
	reply := telegramBotCommandReply(app, userID, settings, command, arg, telegramLocale)
	botToken := strings.TrimSpace(settings.TelegramBotToken)
	if reply != "" {
		// 命令已经处理完就推进 update；sendMessage 失败也不让 Telegram 重试造成重复查询和重复写库。
		_ = telegramBotSendMessage(botToken, binding.GetString("chatId"), reply, settings.TelegramMessageFormat, telegramLocale)
	}
	_ = markTelegramBindingUpdate(app, binding, updateID, true)
	return telegramWebhookOK(e)
}

func rejectInstalledTelegramBotSettingsChange(app core.App, userID string, current appSettings, next appSettings) error {
	if strings.TrimSpace(current.TelegramBotToken) == strings.TrimSpace(next.TelegramBotToken) &&
		strings.TrimSpace(current.TelegramChatID) == strings.TrimSpace(next.TelegramChatID) {
		return nil
	}
	binding, err := findTelegramBotBindingForUser(app, userID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	if binding.GetString("status") != "installed" {
		return nil
	}
	// 已安装命令意味着 Telegram 远端还持有 webhook；先删除 binding/远端命令，才能修改 Bot Token 或 Chat ID。
	return errors.New("TELEGRAM_BOT_COMMANDS_INSTALLED")
}

func telegramBotCommandsDTO(settings appSettings, binding *core.Record) telegramBotCommandsResponse {
	_, chatID, configComplete := telegramBotSavedConfig(settings)
	status := "not_configured"
	installed := false
	var installedAt *string
	var lastUsedAt *string
	var chatIDPtr *string
	if chatID != "" {
		chatIDPtr = &chatID
	}
	if configComplete {
		status = "not_installed"
	}
	if binding != nil && telegramBotBindingMatchesSettings(binding, settings) {
		status = binding.GetString("status")
		installed = status == "installed" && configComplete
		if status == "installed" {
			value := recordTimeString(binding, "created")
			installedAt = &value
		}
		lastUsedAt = optionalRecordString(binding, "lastUsedAt")
	}
	if !configComplete {
		status = "not_configured"
		installed = false
	}
	return telegramBotCommandsResponse{
		ConfigComplete: configComplete,
		Installed:      installed,
		Status:         status,
		ChatID:         chatIDPtr,
		InstalledAt:    installedAt,
		LastUsedAt:     lastUsedAt,
	}
}

func findTelegramBotBindingForUser(app core.App, userID string) (*core.Record, error) {
	return app.FindFirstRecordByFilter("telegram_bot_bindings", "user = {:user}", dbx.Params{"user": userID})
}

func telegramBotSavedConfig(settings appSettings) (string, string, bool) {
	botToken := strings.TrimSpace(settings.TelegramBotToken)
	chatID := strings.TrimSpace(settings.TelegramChatID)
	return botToken, chatID, botToken != "" && chatID != ""
}

func telegramBotBindingMatchesSettings(binding *core.Record, settings appSettings) bool {
	botToken, chatID, ok := telegramBotSavedConfig(settings)
	if !ok {
		return false
	}
	return binding.GetString("chatId") == chatID && binding.GetString("botTokenHash") == hashTelegramSecret(botToken)
}

func telegramWebhookSecretMatches(binding *core.Record, secret string) bool {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return false
	}
	actual := hashTelegramSecret(secret)
	expected := strings.TrimSpace(binding.GetString("webhookSecretHash"))
	return subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) == 1
}

func telegramBotInstallRemote(botToken string, chatID string, webhookURL string, secret string, locale appLocale) error {
	if err := telegramBotPostJSON(botToken, telegramBotAPIMethodSetWebhook, telegramBotSetWebhookRequest{
		URL:                webhookURL,
		AllowedUpdates:     []string{"message"},
		DropPendingUpdates: true,
		MaxConnections:     1,
		SecretToken:        secret,
	}, locale, secret, chatID); err != nil {
		return err
	}
	return telegramBotPostJSON(botToken, telegramBotAPIMethodSetCommands, telegramBotSetMyCommandsRequest{
		Commands: telegramBotMenuCommands(locale),
		Scope:    telegramBotCommandScopeChat{Type: "chat", ChatID: chatID},
	}, locale, chatID)
}

func telegramBotDeleteRemote(botToken string, chatID string, locale appLocale) error {
	if err := telegramBotPostJSON(botToken, telegramBotAPIMethodDeleteHook, telegramBotDeleteWebhookRequest{
		DropPendingUpdates: true,
	}, locale, chatID); err != nil {
		return err
	}
	return telegramBotPostJSON(botToken, telegramBotAPIMethodDelCommands, telegramBotDeleteMyCommandsRequest{
		Scope: telegramBotCommandScopeChat{Type: "chat", ChatID: chatID},
	}, locale, chatID)
}

func telegramBotBestEffortRemoteCleanup(botToken string, chatID string, locale appLocale) {
	_ = telegramBotPostJSON(botToken, telegramBotAPIMethodDeleteHook, telegramBotDeleteWebhookRequest{DropPendingUpdates: true}, locale, chatID)
	_ = telegramBotPostJSON(botToken, telegramBotAPIMethodDelCommands, telegramBotDeleteMyCommandsRequest{
		Scope: telegramBotCommandScopeChat{Type: "chat", ChatID: chatID},
	}, locale, chatID)
}

func telegramBotSendMessage(botToken string, chatID string, text string, format string, locale appLocale) error {
	formatted := formatTelegramBotMessage(text, format)
	return telegramBotPostJSON(botToken, telegramBotAPIMethodSendMessage, telegramSendMessageRequest{
		ChatID:             chatID,
		Text:               formatted.Text,
		ParseMode:          formatted.ParseMode,
		LinkPreviewOptions: &telegramLinkPreviewOptions{IsDisabled: true},
	}, locale, chatID)
}

func defaultTelegramBotPostJSON(botToken string, method string, payload interface{}, locale appLocale, secrets ...string) error {
	secretValues := append([]string{botToken}, secrets...)
	resp, err := postJSON("https://api.telegram.org/bot"+botToken+"/"+method, payload, "Telegram Bot API", locale, secretValues...)
	if err != nil {
		return err
	}
	if responseOK(resp) {
		return nil
	}
	return channelHTTPErrorFromResponse(locale, "Telegram", resp, secretValues...)
}

func telegramBotMenuCommands(locale appLocale) []telegramBotCommand {
	// BotCommand.Description 是 Telegram 菜单纯文本契约；富文本只属于后续 sendMessage，/due 仅保留手输高级入口。
	return []telegramBotCommand{
		{Command: "start", Description: serverText(locale, "telegramBot.menu.start")},
		{Command: "help", Description: serverText(locale, "telegramBot.menu.help")},
		{Command: "status", Description: serverText(locale, "telegramBot.menu.status")},
		{Command: "next", Description: serverText(locale, "telegramBot.menu.next")},
		{Command: "today", Description: serverText(locale, "telegramBot.menu.today")},
		{Command: "week", Description: serverText(locale, "telegramBot.menu.week")},
		{Command: "month", Description: serverText(locale, "telegramBot.menu.month")},
		{Command: "subscriptions", Description: serverText(locale, "telegramBot.menu.subscriptions")},
		{Command: "settings", Description: serverText(locale, "telegramBot.menu.settings")},
	}
}

func telegramBotCommandReply(app core.App, userID string, settings appSettings, command string, arg string, locale appLocale) string {
	// 命令 adapter 只做路由和文本排版；订阅读取必须继续走 Public API owner-scoped service。
	switch command {
	case "start", "help":
		return telegramBotHelpText(locale)
	case "status":
		status, err := publicAPIStatusForUser(app, userID)
		if err != nil {
			return serverText(locale, "telegramBot.error.statusUnavailable")
		}
		return telegramBotStatusText(status, locale)
	case "next":
		item, err := publicAPINextDueForUserWithSettings(app, userID, settings)
		if err != nil {
			return serverText(locale, "telegramBot.error.nextUnavailable")
		}
		return telegramBotNextText(item, locale)
	case "today":
		due, err := publicAPIDueForUserWithSettings(app, userID, 1, settings)
		if err != nil {
			return serverText(locale, "telegramBot.error.dueUnavailable")
		}
		today := todayDateOnly(time.Now().UTC(), settings.Timezone)
		due.Items = filterPublicAPIDueItemsByDate(due.Items, today)
		return telegramBotDueTextWithTitle(due, locale, serverText(locale, "telegramBot.due.todayTitle"))
	case "week":
		due, err := publicAPIDueForUserWithSettings(app, userID, 7, settings)
		if err != nil {
			return serverText(locale, "telegramBot.error.dueUnavailable")
		}
		return telegramBotDueText(due, locale)
	case "month":
		due, err := publicAPIDueForUserWithSettings(app, userID, 30, settings)
		if err != nil {
			return serverText(locale, "telegramBot.error.dueUnavailable")
		}
		return telegramBotDueText(due, locale)
	case "due":
		days := telegramBotDueDays(arg)
		due, err := publicAPIDueForUserWithSettings(app, userID, days, settings)
		if err != nil {
			return serverText(locale, "telegramBot.error.dueUnavailable")
		}
		return telegramBotDueText(due, locale)
	case "subscriptions":
		list, err := publicAPISubscriptionsForUser(app, userID, telegramBotCommandListLimit, "")
		if err != nil {
			return serverText(locale, "telegramBot.error.subscriptionsUnavailable")
		}
		return telegramBotSubscriptionsText(list, locale)
	case "settings":
		return telegramBotSettingsText(settings, locale)
	default:
		return telegramBotHelpText(locale)
	}
}

func telegramBotHelpText(locale appLocale) string {
	return strings.Join([]string{
		serverText(locale, "telegramBot.help.title"),
		serverText(locale, "telegramBot.help.status"),
		serverText(locale, "telegramBot.help.next"),
		serverText(locale, "telegramBot.help.today"),
		serverText(locale, "telegramBot.help.week"),
		serverText(locale, "telegramBot.help.month"),
		serverFormat(locale, "telegramBot.help.due", map[string]interface{}{"days": telegramBotCommandDueDefault}),
		serverFormat(locale, "telegramBot.help.subscriptions", map[string]interface{}{"limit": telegramBotCommandListLimit}),
		serverText(locale, "telegramBot.help.settings"),
		serverText(locale, "telegramBot.help.help"),
	}, "\n")
}

func telegramBotStatusText(response publicAPIStatusResponse, locale appLocale) string {
	lines := []string{
		serverText(locale, "telegramBot.status.title"),
		serverFormat(locale, "telegramBot.status.total", map[string]interface{}{"count": response.Total}),
	}
	for _, status := range []string{"trial", "active", "expired", "paused", "cancelled"} {
		lines = append(lines, serverFormat(locale, "telegramBot.status."+status, map[string]interface{}{"count": response.ByStatus[status]}))
	}
	return strings.Join(lines, "\n")
}

func telegramBotDueText(response publicAPIDueResponse, locale appLocale) string {
	title := serverFormat(locale, "telegramBot.due.title", map[string]interface{}{"days": response.Days})
	return telegramBotDueTextWithTitle(response, locale, title)
}

func telegramBotNextText(item *publicAPIDueItem, locale appLocale) string {
	lines := []string{serverText(locale, "telegramBot.next.title")}
	if item == nil {
		return strings.Join(append(lines, serverText(locale, "telegramBot.next.empty")), "\n")
	}
	return strings.Join(append(lines, serverFormat(locale, "telegramBot.next.item", map[string]interface{}{
		"date": item.DueDate,
		"name": telegramBotSubscriptionName(item.Subscription, locale),
		"type": telegramBotDueTypeText(locale, item.DueType),
	})), "\n")
}

func telegramBotDueTextWithTitle(response publicAPIDueResponse, locale appLocale, title string) string {
	items := append([]publicAPIDueItem(nil), response.Items...)
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].DueDate == items[j].DueDate {
			return publicAPISubscriptionName(items[i].Subscription) < publicAPISubscriptionName(items[j].Subscription)
		}
		return items[i].DueDate < items[j].DueDate
	})
	lines := []string{title}
	if len(items) == 0 {
		return strings.Join(append(lines, serverText(locale, "telegramBot.due.empty")), "\n")
	}
	visible := items
	if len(visible) > telegramBotCommandListLimit {
		visible = visible[:telegramBotCommandListLimit]
	}
	for _, item := range visible {
		lines = append(lines, serverFormat(locale, "telegramBot.due.item", map[string]interface{}{
			"date": item.DueDate,
			"name": telegramBotSubscriptionName(item.Subscription, locale),
			"type": telegramBotDueTypeText(locale, item.DueType),
		}))
	}
	if remaining := len(items) - len(visible); remaining > 0 {
		lines = append(lines, serverFormat(locale, "telegramBot.due.truncated", map[string]interface{}{"count": remaining}))
	}
	return strings.Join(lines, "\n")
}

func telegramBotSettingsText(settings appSettings, locale appLocale) string {
	messageStyle := serverText(locale, "telegramBot.settings.messageStyle.plain")
	if settings.TelegramMessageFormat == telegramMessageFormatHTML {
		messageStyle = serverText(locale, "telegramBot.settings.messageStyle.html")
	}
	return strings.Join([]string{
		serverText(locale, "telegramBot.settings.title"),
		serverFormat(locale, "telegramBot.settings.chatId", map[string]interface{}{
			"chatId": fallbackText(strings.TrimSpace(settings.TelegramChatID), serverText(locale, "telegramBot.settings.notConfigured")),
		}),
		serverFormat(locale, "telegramBot.settings.messageStyle", map[string]interface{}{"style": messageStyle}),
		serverText(locale, "telegramBot.settings.manage"),
	}, "\n")
}

func filterPublicAPIDueItemsByDate(items []publicAPIDueItem, date string) []publicAPIDueItem {
	out := []publicAPIDueItem{}
	for _, item := range items {
		if item.DueDate == date {
			out = append(out, item)
		}
	}
	return out
}

func telegramBotSubscriptionsText(response publicAPISubscriptionsResponse, locale appLocale) string {
	lines := []string{serverFormat(locale, "telegramBot.subscriptions.title", map[string]interface{}{"total": response.Total})}
	if len(response.Subscriptions) == 0 {
		return strings.Join(append(lines, serverText(locale, "telegramBot.subscriptions.empty")), "\n")
	}
	for _, subscription := range response.Subscriptions {
		lines = append(lines, serverFormat(locale, "telegramBot.subscriptions.item", map[string]interface{}{
			"name":   telegramBotSubscriptionName(subscription, locale),
			"status": telegramBotSubscriptionStatus(subscription, locale),
			"date":   telegramBotSubscriptionNextDate(subscription, locale),
		}))
	}
	if response.Total > int64(len(response.Subscriptions)) {
		lines = append(lines, serverFormat(locale, "telegramBot.subscriptions.truncated", map[string]interface{}{"count": response.Total - int64(len(response.Subscriptions))}))
	}
	return strings.Join(lines, "\n")
}

func telegramBotSubscriptionName(subscription publicAPISubscriptionResponse, locale appLocale) string {
	if name := strings.TrimSpace(subscription.Name); name != "" {
		return name
	}
	return serverText(locale, "telegramBot.subscription.unnamed")
}

func publicAPISubscriptionName(subscription publicAPISubscriptionResponse) string {
	if name := strings.TrimSpace(subscription.Name); name != "" {
		return name
	}
	return "Unnamed subscription"
}

func telegramBotSubscriptionStatus(subscription publicAPISubscriptionResponse, locale appLocale) string {
	if status := strings.TrimSpace(subscription.Status); status != "" {
		return telegramBotStatusLabel(locale, status)
	}
	return serverText(locale, "telegramBot.subscriptionStatus.unknown")
}

func telegramBotSubscriptionNextDate(subscription publicAPISubscriptionResponse, locale appLocale) string {
	if nextDate := strings.TrimSpace(subscription.NextBillingDate); nextDate != "" {
		return nextDate
	}
	return serverText(locale, "telegramBot.subscription.unknown")
}

func telegramBotDueTypeText(locale appLocale, dueType string) string {
	switch dueType {
	case "renewal", "trial", "expiry":
		return serverText(locale, "telegramBot.dueType."+dueType)
	default:
		return serverText(locale, "telegramBot.subscription.unknown")
	}
}

func telegramBotStatusLabel(locale appLocale, status string) string {
	switch status {
	case "trial", "active", "expired", "paused", "cancelled":
		return serverText(locale, "telegramBot.subscriptionStatus."+status)
	default:
		return serverText(locale, "telegramBot.subscriptionStatus.unknown")
	}
}

func telegramBotDueDays(arg string) int {
	arg = strings.TrimSpace(arg)
	if arg == "" {
		return telegramBotCommandDueDefault
	}
	value, err := strconv.Atoi(arg)
	if err != nil || value < 1 {
		return telegramBotCommandDueDefault
	}
	if value > telegramBotCommandDueMax {
		return telegramBotCommandDueMax
	}
	return value
}

func parseTelegramCommand(text string) (string, string, bool) {
	text = strings.TrimSpace(text)
	if !strings.HasPrefix(text, "/") {
		return "", "", false
	}
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return "", "", false
	}
	command := strings.TrimPrefix(fields[0], "/")
	if index := strings.Index(command, "@"); index >= 0 {
		command = command[:index]
	}
	command = strings.ToLower(strings.TrimSpace(command))
	if command == "" {
		return "", "", false
	}
	arg := ""
	if len(fields) > 1 {
		arg = fields[1]
	}
	return command, arg, true
}

func markTelegramBindingUpdate(app core.App, binding *core.Record, updateID int64, used bool) error {
	// 只有真实命令路径会调用这里；no-op update 不写 lastUpdateId，避免 foreign chat 抢占后续合法 update。
	binding.Set("lastUpdateId", updateID)
	if used {
		binding.Set("lastUsedAt", time.Now().UTC().Format(time.RFC3339Nano))
	}
	return app.Save(binding)
}

func readTelegramWebhookUpdate(reader io.Reader) (telegramWebhookUpdate, error) {
	var update telegramWebhookUpdate
	if reader == nil {
		return update, io.EOF
	}
	limited := io.LimitReader(reader, telegramWebhookUpdateBodyMax+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return update, err
	}
	if len(data) > telegramWebhookUpdateBodyMax {
		return update, errors.New("telegram update body too large")
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	// Telegram Update 是官方可扩展 payload；这里只读取 update_id/message.chat.id/message.text，未知字段必须被宽松接受。
	if err := decoder.Decode(&update); err != nil {
		return update, err
	}
	return update, nil
}

func (id *telegramChatID) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		*id = ""
		return nil
	}
	var text string
	if strings.HasPrefix(trimmed, `"`) {
		if err := json.Unmarshal(data, &text); err != nil {
			return err
		}
		*id = telegramChatID(strings.TrimSpace(text))
		return nil
	}
	var number json.Number
	if err := json.Unmarshal(data, &number); err != nil {
		return err
	}
	*id = telegramChatID(number.String())
	return nil
}

func telegramBotExternalOrigin(request *http.Request) (url.URL, error) {
	origin := externalRequestOrigin(request)
	if raw := strings.TrimSpace(os.Getenv("APP_URL")); raw != "" {
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return url.URL{}, errors.New("invalid app url")
		}
		parsed.Path = ""
		parsed.RawQuery = ""
		parsed.Fragment = ""
		// Telegram webhook 复用公开链接 origin；Docker 默认本地 APP_URL 不能抢占反代还原出的 HTTPS 公网地址。
		if telegramBotLocalAppURLOrigin(*parsed) {
			return origin, nil
		}
		return *parsed, nil
	}
	return origin, nil
}

func telegramBotLocalAppURLOrigin(origin url.URL) bool {
	hostname := strings.ToLower(origin.Hostname())
	if hostname == "localhost" {
		return true
	}
	ip := net.ParseIP(hostname)
	return ip != nil && ip.IsLoopback()
}

func telegramBotWebhookURL(origin url.URL, bindingID string) string {
	origin.Path = "/api/telegram/webhook/" + bindingID
	origin.RawQuery = ""
	origin.Fragment = ""
	return origin.String()
}

func newTelegramWebhookSecret() (string, error) {
	data := make([]byte, telegramWebhookSecretBytes)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}

func hashTelegramSecret(value string) string {
	sum := sha256.Sum256([]byte(value))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func telegramBotBadRequest(e *core.RequestEvent, code string, message string, _ error) error {
	setPublicAPIHeaders(e.Response.Header())
	return apiErrorJSON(e, http.StatusBadRequest, code, message, nil)
}

func telegramBotUpstreamError(e *core.RequestEvent, err error) error {
	locale := requestLocale(e.Request)
	var details any
	if errorDetails := notificationChannelErrorDetails(err); errorDetails != nil {
		details = errorDetails
	}
	setPublicAPIHeaders(e.Response.Header())
	return apiErrorJSON(e, http.StatusBadGateway, "TELEGRAM_API_FAILED", serverText(locale, "common.internalError"), details)
}

func telegramWebhookOK(e *core.RequestEvent) error {
	setPublicAPIHeaders(e.Response.Header())
	return e.JSON(http.StatusOK, map[string]bool{"ok": true})
}
