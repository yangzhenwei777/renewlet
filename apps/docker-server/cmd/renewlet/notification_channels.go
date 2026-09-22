package main

// notification_channels.go 负责非邮件通知渠道和渠道分发。
//
// 架构位置：统一 notificationMessage 在这里被转换为各通知渠道的外部请求。
// 外部服务失败被收敛为 channelFailure，调度层据此决定 sent/failed 和后续重试范围。
//
// 注意： Webhook、DingTalk、WeCom、Bark 和 Discord 都可能携带用户配置 URL，必须经过对应公网 HTTPS 防护后才能请求。
import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

var serverChanSCTPSendKeyRe = regexp.MustCompile(`^sctp(\d+)t`)

type notificationSender interface {
	Send(core.App, appSettings, notificationMessage, appLocale) error
}

type notificationSenderFunc func(core.App, appSettings, notificationMessage, appLocale) error

func (fn notificationSenderFunc) Send(app core.App, settings appSettings, message notificationMessage, locale appLocale) error {
	return fn(app, settings, message, locale)
}

// notificationSenders 是 Go 运行面的渠道 registry；调度 job 幂等、失败重试和 raw details 剥离不在这里分叉。
var notificationSenders = map[string]notificationSender{
	"telegram": notificationSenderFunc(func(_ core.App, settings appSettings, message notificationMessage, locale appLocale) error {
		return sendTelegram(settings, message, locale)
	}),
	"notifyx": notificationSenderFunc(func(_ core.App, settings appSettings, message notificationMessage, locale appLocale) error {
		return sendNotifyx(settings, message, locale)
	}),
	"webhook": notificationSenderFunc(func(_ core.App, settings appSettings, message notificationMessage, locale appLocale) error {
		return sendWebhook(settings, message, locale)
	}),
	"dingtalk": notificationSenderFunc(func(_ core.App, settings appSettings, message notificationMessage, locale appLocale) error {
		return sendDingTalk(settings, message, locale)
	}),
	"wechat": notificationSenderFunc(func(_ core.App, settings appSettings, message notificationMessage, locale appLocale) error {
		return sendWeChatWork(settings, message, locale)
	}),
	"email": notificationSenderFunc(func(_ core.App, settings appSettings, message notificationMessage, locale appLocale) error {
		return sendEmail(settings, message, locale)
	}),
	"bark": notificationSenderFunc(func(_ core.App, settings appSettings, message notificationMessage, locale appLocale) error {
		return sendBark(settings, message, locale)
	}),
	"serverchan": notificationSenderFunc(func(_ core.App, settings appSettings, message notificationMessage, locale appLocale) error {
		return sendServerChan(settings, message, locale)
	}),
	"discord": notificationSenderFunc(func(_ core.App, settings appSettings, message notificationMessage, locale appLocale) error {
		return sendDiscord(settings, message, locale)
	}),
	"pushplus": notificationSenderFunc(func(_ core.App, settings appSettings, message notificationMessage, locale appLocale) error {
		return sendPushPlus(settings, message, locale)
	}),
}

func sendToChannels(app core.App, channels []string, settings appSettings, message notificationMessage, locale appLocale) sendSummary {
	summary := sendSummary{
		Attempted: append([]string(nil), channels...),
		Succeeded: []string{},
		Failed:    []channelFailure{},
	}
	for _, channel := range channels {
		// 串行发送牺牲一点延迟，换来确定性的 history 顺序，并降低同一分钟对多个外部服务的突发压力。
		if err := sendToChannel(app, channel, settings, message, locale); err != nil {
			summary.Failed = append(summary.Failed, channelFailure{Channel: channel, Error: err.Error(), Details: notificationChannelErrorDetails(err)})
		} else {
			summary.Succeeded = append(summary.Succeeded, channel)
		}
	}
	return summary
}

// sendToChannel 将统一消息分发到具体通知渠道。
// 注意： 新增渠道时必须同步 knownChannels、settings schema、前端渠道枚举和 history result schema。
func sendToChannel(app core.App, channel string, settings appSettings, message notificationMessage, locale appLocale) error {
	sender, ok := notificationSenders[channel]
	if !ok {
		return errors.New(serverFormat(locale, "notification.channelUnknown", map[string]interface{}{"channel": channel}))
	}
	return sender.Send(app, settings, message, locale)
}

// sendTelegram 发送 Telegram Bot 消息。
// Telegram/网络 429 或 5xx 会短重试，其他 4xx 直接失败，避免无效配置反复打扰外部 API。
func sendTelegram(settings appSettings, message notificationMessage, locale appLocale) error {
	token, err := requireNonEmptyLocalized(locale, serverText(locale, "service.telegramBotToken"), settings.TelegramBotToken)
	if err != nil {
		return err
	}
	chatID, err := requireNonEmptyLocalized(locale, serverText(locale, "service.telegramChatID"), settings.TelegramChatID)
	if err != nil {
		return err
	}
	endpoint := "https://api.telegram.org/bot" + token + "/sendMessage"
	// Telegram 样式只在 sendMessage 边界生效；其它渠道继续消费纯文本，避免跨渠道模板语义互相污染。
	formatted := formatTelegramNotificationMessage(message, settings.TelegramMessageFormat)
	body := telegramSendMessageRequest{
		ChatID:             chatID,
		Text:               formatted.Text,
		ParseMode:          formatted.ParseMode,
		LinkPreviewOptions: &telegramLinkPreviewOptions{IsDisabled: true},
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		resp, err := postJSON(endpoint, body, "Telegram Bot API", locale, token, chatID)
		if err == nil && responseOK(resp) {
			return nil
		}
		if err != nil {
			lastErr = err
		} else {
			statusCode := resp.StatusCode
			lastErr = channelHTTPErrorFromResponse(locale, "Telegram", resp, token, chatID)
			if statusCode != http.StatusTooManyRequests && statusCode < 500 {
				// 配置错误类 4xx 不重试，避免每轮 cron 都重复打到外部 API。
				break
			}
		}
		time.Sleep(time.Duration(500*(1<<attempt)) * time.Millisecond)
	}
	return lastErr
}

// sendNotifyx 发送 NotifyX 消息。
func sendNotifyx(settings appSettings, message notificationMessage, locale appLocale) error {
	apiKey, err := requireNonEmptyLocalized(locale, serverText(locale, "service.notifyxAPIKey"), settings.NotifyxAPIKey)
	if err != nil {
		return err
	}
	endpoint := "https://www.notifyx.cn/api/v1/send/" + url.PathEscape(apiKey)
	resp, err := postJSON(endpoint, notifyxSendRequest{
		Title:       message.Title,
		Content:     message.Content,
		Description: message.Timestamp,
	}, "NotifyX API", locale, apiKey)
	if err != nil {
		return err
	}
	if responseOK(resp) {
		return nil
	}
	return channelHTTPErrorFromResponse(locale, "NotifyX", resp, apiKey)
}

// sendDiscord 发送 Discord Webhook 消息。
func sendDiscord(settings appSettings, message notificationMessage, locale appLocale) error {
	rawWebhook, err := requireNonEmptyLocalized(locale, serverText(locale, "service.discordWebhookURL"), settings.DiscordWebhookURL)
	if err != nil {
		return err
	}
	endpoint, err := discordWebhookEndpoint(rawWebhook, locale)
	if err != nil {
		return err
	}
	payload := discordWebhookRequest{
		Content: truncateRunes(buildTextMessage(message), discordContentMaxRunes),
		// Discord 默认会解析 @everyone、用户和角色提及；通知内容含订阅名/备注，必须固定禁止误 ping。
		AllowedMentions: discordAllowedMentions{Parse: []string{}},
	}
	if username := strings.TrimSpace(settings.DiscordBotUsername); username != "" {
		payload.Username = username
	}
	if rawAvatar := strings.TrimSpace(settings.DiscordBotAvatarURL); rawAvatar != "" {
		avatar := safePublicHTTPSIconURL(rawAvatar)
		if avatar == "" {
			return errors.New(serverFormat(locale, "url.invalid", map[string]interface{}{"label": serverText(locale, "service.discordBotAvatarURL")}))
		}
		payload.AvatarURL = avatar
	}
	secrets := discordWebhookSecrets(rawWebhook, endpoint, payload.AvatarURL)
	resp, err := postJSON(endpoint, payload, "Discord", locale, secrets...)
	if err != nil {
		return err
	}
	if responseOK(resp) {
		return nil
	}
	return channelHTTPErrorFromResponse(locale, "Discord", resp, secrets...)
}

func discordWebhookEndpoint(rawURL string, locale appLocale) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New(serverFormat(locale, "url.invalid", map[string]interface{}{"label": serverText(locale, "service.discordWebhookURL")}))
	}
	if parsed.Scheme != "https" {
		return "", errors.New(serverFormat(locale, "url.mustUseHttps", map[string]interface{}{"label": serverText(locale, "service.discordWebhookURL")}))
	}
	if parsed.User != nil || strings.ToLower(parsed.Hostname()) != "discord.com" || parsed.Port() != "" {
		return "", errors.New(serverFormat(locale, "url.invalid", map[string]interface{}{"label": serverText(locale, "service.discordWebhookURL")}))
	}
	parts := strings.Split(strings.Trim(strings.TrimPrefix(parsed.Path, "/api/webhooks/"), "/"), "/")
	if !strings.HasPrefix(parsed.Path, "/api/webhooks/") || len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", errors.New(serverFormat(locale, "url.invalid", map[string]interface{}{"label": serverText(locale, "service.discordWebhookURL")}))
	}
	query := parsed.Query()
	query.Set("wait", "true")
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func discordWebhookSecrets(rawWebhook, endpoint, avatarURL string) []string {
	token := ""
	if parsed, err := url.Parse(endpoint); err == nil {
		parts := strings.Split(strings.Trim(strings.TrimPrefix(parsed.Path, "/api/webhooks/"), "/"), "/")
		if len(parts) == 2 {
			token = parts[1]
		}
	}
	return []string{rawWebhook, endpoint, token, avatarURL}
}

func truncateRunes(value string, limit int) string {
	if limit < 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

// sendWebhook 发送用户自定义 Webhook。
// 注意： URL 必须经过 assertSafeOutboundURL，防止 Webhook 被用作 SSRF 到内网服务。
func sendWebhook(settings appSettings, message notificationMessage, locale appLocale) error {
	rawURL, err := requireNonEmptyLocalized(locale, serverText(locale, "service.webhookURL"), settings.WebhookURL)
	if err != nil {
		return err
	}
	safeURL, err := assertSafeOutboundURL(rawURL, "Webhook URL", locale)
	if err != nil {
		return err
	}
	headers, err := parseHeaderJSON(settings.WebhookHeaders, locale)
	if err != nil {
		return err
	}
	if settings.WebhookMethod == "GET" {
		u := *safeURL
		q := u.Query()
		// GET Webhook 兼容只支持 query 的自动化平台；敏感订阅内容会进入对方访问日志，用户应优先选 POST。
		q.Set("title", message.Title)
		q.Set("content", message.Content)
		q.Set("timestamp", message.Timestamp)
		u.RawQuery = q.Encode()
		resp, err := sendHTTPRequest(http.MethodGet, u.String(), headers, nil, "Webhook", locale, webhookSecrets(safeURL.String(), headers)...)
		if err != nil {
			return err
		}
		if responseOK(resp) {
			return nil
		}
		return channelHTTPErrorFromResponse(locale, "Webhook", resp, webhookSecrets(safeURL.String(), headers)...)
	}

	body, err := renderWebhookPayloadTemplate(settings.WebhookPayload, message, locale)
	if err != nil {
		return err
	}
	if _, ok := headers["content-type"]; !ok {
		headers["content-type"] = "application/json"
	}
	resp, err := sendHTTPRequest(http.MethodPost, safeURL.String(), headers, body, "Webhook", locale, webhookSecrets(safeURL.String(), headers)...)
	if err != nil {
		return err
	}
	if responseOK(resp) {
		return nil
	}
	return channelHTTPErrorFromResponse(locale, "Webhook", resp, webhookSecrets(safeURL.String(), headers)...)
}

// sendDingTalk 发送钉钉自定义机器人消息。
func sendDingTalk(settings appSettings, message notificationMessage, locale appLocale) error {
	rawURL, err := requireNonEmptyLocalized(locale, serverText(locale, "service.dingtalkWebhookURL"), settings.DingTalkWebhookURL)
	if err != nil {
		return err
	}
	safeURL, err := assertSafeOutboundURL(rawURL, serverText(locale, "service.dingtalkWebhookURL"), locale)
	if err != nil {
		return err
	}
	endpoint := safeURL.String()
	if strings.TrimSpace(settings.DingTalkSecret) != "" {
		endpoint, err = signedDingTalkWebhookURL(endpoint, settings.DingTalkSecret, time.Now())
		if err != nil {
			return err
		}
	}
	payload := dingTalkRequestPayload(settings, message)
	secrets := dingTalkSecrets(rawURL, endpoint, settings.DingTalkSecret)
	resp, err := postJSON(endpoint, payload, "DingTalk", locale, secrets...)
	if err != nil {
		return err
	}
	return requireDingTalkSuccess(resp, locale, secrets...)
}

func dingTalkRequestPayload(settings appSettings, message notificationMessage) interface{} {
	rendered := renderDingTalkNotification(settings, message)
	if settings.DingTalkMessageType == dingtalkMessageTypeText {
		return dingTalkTextRequest{
			MsgType: dingtalkMessageTypeText,
			Text:    dingTalkTextMessage{Content: rendered.Content},
		}
	}
	return dingTalkMarkdownRequest{
		MsgType: dingtalkMessageTypeMarkdown,
		Markdown: dingTalkMarkdownMessage{
			Title: rendered.Title,
			Text:  rendered.Content,
		},
	}
}

type dingTalkRenderedNotification struct {
	Title   string
	Content string
}

func renderDingTalkNotification(settings appSettings, message notificationMessage) dingTalkRenderedNotification {
	title := message.Title
	if strings.TrimSpace(settings.DingTalkTitleTemplate) != "" {
		renderedTitle := strings.TrimSpace(renderDingTalkTemplate(settings.DingTalkTitleTemplate, message, settings.DingTalkKeyword))
		if renderedTitle != "" {
			title = renderedTitle
		}
	}
	content := buildTextMessage(message)
	if strings.TrimSpace(settings.DingTalkContentTemplate) != "" {
		renderedContent := strings.TrimSpace(renderDingTalkTemplate(settings.DingTalkContentTemplate, message, settings.DingTalkKeyword))
		if renderedContent != "" {
			content = renderedContent
		}
	}
	return dingTalkRenderedNotification{
		Title:   title,
		Content: ensureDingTalkContentMarkers(content, settings.DingTalkKeyword),
	}
}

func renderDingTalkTemplate(template string, message notificationMessage, keyword string) string {
	// 钉钉模板只改官方 payload 的文本字段；raw JSON body 会绕开 msgtype/errcode 约束并重现交付误判。
	return strings.NewReplacer(
		"{brand}", "Renewlet",
		"{keyword}", strings.TrimSpace(keyword),
		"{title}", message.Title,
		"{content}", message.Content,
		"{timestamp}", message.Timestamp,
		"{itemCount}", fmt.Sprintf("%d", len(message.Items)),
	).Replace(template)
}

func ensureDingTalkContentMarkers(content string, keyword string) string {
	// 钉钉关键词校验只看可见正文，不能藏在 title 或不可见字符里；缺失标记放末尾，避免抢走通知第一屏。
	markers := []string{}
	if !strings.Contains(content, "Renewlet") {
		markers = append(markers, "Renewlet")
	}
	keyword = strings.TrimSpace(keyword)
	if keyword != "" && !strings.Contains(content, keyword) && !dingTalkMarkerQueued(markers, keyword) {
		markers = append(markers, keyword)
	}
	if len(markers) == 0 {
		return content
	}
	trimmedContent := strings.TrimRight(content, " \t\r\n")
	if trimmedContent == "" {
		return strings.Join(markers, " · ")
	}
	return trimmedContent + "\n\n" + strings.Join(markers, " · ")
}

func dingTalkMarkerQueued(markers []string, marker string) bool {
	for _, existing := range markers {
		if existing == marker {
			return true
		}
	}
	return false
}

func signedDingTalkWebhookURL(endpoint string, secret string, now time.Time) (string, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	timestamp := fmt.Sprintf("%d", now.UnixMilli())
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp + "\n" + secret))
	sign := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	// timestamp/sign 是钉钉加签凭据；覆盖旧 query，避免用户复制的过期签名被继续发送或写进诊断。
	query := parsed.Query()
	query.Set("timestamp", timestamp)
	query.Set("sign", sign)
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func dingTalkSecrets(rawURL, endpoint, secret string) []string {
	out := []string{rawURL, endpoint, secret}
	if parsed, err := url.Parse(endpoint); err == nil {
		query := parsed.Query()
		out = append(out, query.Get("access_token"), query.Get("sign"))
	}
	return out
}

func requireDingTalkSuccess(resp *http.Response, locale appLocale, secrets ...string) error {
	if resp == nil {
		return channelHTTPError(locale, "DingTalk", 0, "")
	}
	providerResponse, rawBody, err := captureUpstreamProviderResponse(resp, secrets)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail := dingTalkErrorDetail(rawBody, providerResponse, locale, secrets)
		return newNotificationChannelError(
			channelHTTPErrorMessage(locale, "DingTalk", resp.StatusCode, detail),
			createUpstreamErrorDetails(providerResponse, detail),
		)
	}
	var result dingTalkSendResponse
	if err := json.Unmarshal([]byte(rawBody), &result); err != nil {
		detail := fallbackText(upstreamProviderMessage(providerResponse), serverText(locale, "service.dingtalkResponseInvalid"))
		return newNotificationChannelError(
			channelHTTPErrorMessage(locale, "DingTalk", resp.StatusCode, detail),
			createUpstreamErrorDetails(providerResponse, detail),
		)
	}
	// 钉钉自定义机器人会把关键词/签名/IP 白名单失败包在 HTTP 200 里；errcode=0 才是真成功。
	if result.ErrCode == nil {
		return newNotificationChannelError(
			channelHTTPErrorMessage(locale, "DingTalk", resp.StatusCode, serverText(locale, "service.dingtalkResponseInvalid")),
			createUpstreamErrorDetails(providerResponse, upstreamProviderMessage(providerResponse)),
		)
	}
	if *result.ErrCode != 0 {
		detail := fallbackText(redactUpstreamSecrets(dingTalkResponseMessage(result), secrets), serverText(locale, "service.dingtalkResponseInvalid"))
		return newNotificationChannelError(
			channelHTTPErrorMessage(locale, "DingTalk", resp.StatusCode, detail),
			createUpstreamErrorDetails(providerResponse, detail),
		)
	}
	return nil
}

func dingTalkErrorDetail(rawBody string, providerResponse *upstreamProviderResponse, locale appLocale, secrets []string) string {
	var result dingTalkSendResponse
	if err := json.Unmarshal([]byte(rawBody), &result); err == nil {
		if detail := redactUpstreamSecrets(dingTalkResponseMessage(result), secrets); detail != "" {
			return detail
		}
	}
	return fallbackText(upstreamProviderMessage(providerResponse), serverText(locale, "service.dingtalkResponseInvalid"))
}

func dingTalkResponseMessage(result dingTalkSendResponse) string {
	if result.ErrCode == nil {
		return strings.TrimSpace(result.ErrMsg)
	}
	text := strings.TrimSpace(result.ErrMsg)
	if text == "" {
		return fmt.Sprintf("errcode=%d", *result.ErrCode)
	}
	return fmt.Sprintf("errcode=%d %s", *result.ErrCode, text)
}

// sendWeChatWork 发送企业微信机器人消息。
func sendWeChatWork(settings appSettings, message notificationMessage, locale appLocale) error {
	rawURL, err := requireNonEmptyLocalized(locale, localizedFieldLabel(locale, "wechatWebhookURL"), settings.WechatWebhookURL)
	if err != nil {
		return err
	}
	safeURL, err := assertSafeOutboundURL(rawURL, localizedFieldLabel(locale, "wechatWebhookURL"), locale)
	if err != nil {
		return err
	}
	content := buildTextMessage(message)
	if settings.WechatAddModeTag {
		content = "【Renewlet】\n" + content
	}
	if settings.WechatMessageType == "markdown" {
		resp, err := postJSON(safeURL.String(), wechatMarkdownRequest{
			MsgType:  "markdown",
			Markdown: wechatMarkdownMessage{Content: content},
		}, serverText(locale, "service.wecomAPI"), locale, safeURL.String())
		if err != nil {
			return err
		}
		if responseOK(resp) {
			return nil
		}
		return channelHTTPErrorFromResponse(locale, "WeCom", resp, safeURL.String())
	} else {
		phones := splitList(settings.WechatAtPhones)
		if settings.WechatAtAll {
			phones = append([]string{"@all"}, phones...)
		}
		resp, err := postJSON(safeURL.String(), wechatTextRequest{
			MsgType: "text",
			Text: wechatTextMessage{
				Content:             content,
				MentionedMobileList: phones,
			},
		}, serverText(locale, "service.wecomAPI"), locale, safeURL.String())
		if err != nil {
			return err
		}
		if responseOK(resp) {
			return nil
		}
		return channelHTTPErrorFromResponse(locale, "WeCom", resp, safeURL.String())
	}
}

// sendBark 发送 Bark 推送。
func sendBark(settings appSettings, message notificationMessage, locale appLocale) error {
	parsed, err := buildBarkRequestURL(settings, message, locale)
	if err != nil {
		return err
	}
	safeURL, err := assertSafeOutboundURL(parsed.String(), serverText(locale, "service.barkServerURL"), locale)
	if err != nil {
		return err
	}
	resp, err := sendHTTPRequest(http.MethodGet, safeURL.String(), nil, nil, "Bark API", locale, settings.BarkDeviceKey, safeURL.String())
	if err != nil {
		return err
	}
	if responseOK(resp) {
		return nil
	}
	return channelHTTPErrorFromResponse(locale, "Bark", resp, settings.BarkDeviceKey, safeURL.String())
}

// buildBarkRequestURL 构造 Bark GET 请求 URL。
func buildBarkRequestURL(settings appSettings, message notificationMessage, locale appLocale) (*url.URL, error) {
	serverRaw, err := requireNonEmptyLocalized(locale, localizedFieldLabel(locale, "barkServerURL"), settings.BarkServerURL)
	if err != nil {
		return nil, err
	}
	deviceKey, err := requireNonEmptyLocalized(locale, localizedFieldLabel(locale, "barkDeviceKey"), settings.BarkDeviceKey)
	if err != nil {
		return nil, err
	}
	server := strings.TrimRight(serverRaw, "/")
	body := message.Content + "\n\n" + message.Timestamp
	rawURL := fmt.Sprintf("%s/%s/%s/%s", server, url.PathEscape(deviceKey), url.PathEscape(message.Title), url.PathEscape(body))
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	q := parsed.Query()
	q.Set("group", "Renewlet")
	if iconURL := barkNotificationIconURL(message); iconURL != "" {
		q.Set("icon", iconURL)
	}
	if settings.BarkSilentPush {
		q.Set("sound", "none")
	}
	parsed.RawQuery = q.Encode()
	return parsed, nil
}

// barkNotificationIconURL 在只有一个提醒项时尝试附带公开 HTTPS 图标。
func barkNotificationIconURL(message notificationMessage) string {
	if len(message.Items) != 1 {
		return ""
	}
	return safePublicHTTPSIconURL(message.Items[0].LogoURL)
}

// safePublicHTTPSIconURL 过滤不能暴露给第三方推送服务的图标 URL。
// 防御点：拒绝 localhost、内网 IP、非 HTTPS 和包含 userinfo 的 URL。
func safePublicHTTPSIconURL(rawURL string) string {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return ""
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return ""
	}
	if ip := net.ParseIP(host); ip != nil && isUnsafeOutboundIP(ip) {
		return ""
	}
	return parsed.String()
}

// sendServerChan 发送 Server酱 Turbo / Server酱³ 推送。
func sendServerChan(settings appSettings, message notificationMessage, locale appLocale) error {
	sendKey, err := requireNonEmptyLocalized(locale, serverText(locale, "service.serverchanSendKey"), settings.ServerChanSendKey)
	if err != nil {
		return err
	}
	endpoint, err := buildServerChanEndpoint(sendKey, locale)
	if err != nil {
		return err
	}
	resp, err := postServerChanJSON(endpoint, serverChanSendRequest{
		Title: message.Title,
		Desp:  message.Content + "\n\n" + message.Timestamp,
	}, locale, sendKey)
	if err != nil {
		return err
	}
	return requireServerChanSuccess(resp, locale, sendKey)
}

// sendPushPlus 发送 PushPlus 消息。
func sendPushPlus(settings appSettings, message notificationMessage, locale appLocale) error {
	token, err := requireNonEmptyLocalized(locale, serverText(locale, "service.pushplusToken"), settings.PushPlusToken)
	if err != nil {
		return err
	}
	resp, err := postJSON("https://www.pushplus.plus/send", pushPlusSendRequest{
		Token:    token,
		Title:    message.Title,
		Content:  message.Content + "\n\n" + message.Timestamp,
		Template: "txt",
	}, "PushPlus", locale, token)
	if err != nil {
		return err
	}
	// PushPlus 2xx 只代表 HTTP 成功；官方业务 code=200 才表示请求被接收，渠道内不重试以免撞频率/额度限制。
	return requirePushPlusSuccess(resp, locale, token)
}

func requirePushPlusSuccess(resp *http.Response, locale appLocale, token string) error {
	if resp == nil {
		return channelHTTPError(locale, "PushPlus", 0, "")
	}
	providerResponse, rawBody, err := captureUpstreamProviderResponse(resp, []string{token})
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail := fallbackText(upstreamProviderMessage(providerResponse), serverText(locale, "service.pushplusResponseInvalid"))
		return newNotificationChannelError(
			channelHTTPErrorMessage(locale, "PushPlus", resp.StatusCode, detail),
			createUpstreamErrorDetails(providerResponse, detail),
		)
	}
	var result pushPlusSendResponse
	if err := json.Unmarshal([]byte(rawBody), &result); err != nil {
		return newNotificationChannelError(
			channelHTTPErrorMessage(locale, "PushPlus", resp.StatusCode, fallbackText(upstreamProviderMessage(providerResponse), serverText(locale, "service.pushplusResponseInvalid"))),
			createUpstreamErrorDetails(providerResponse, upstreamProviderMessage(providerResponse)),
		)
	}
	if result.Code == nil {
		return newNotificationChannelError(
			channelHTTPErrorMessage(locale, "PushPlus", resp.StatusCode, serverText(locale, "service.pushplusResponseInvalid")),
			createUpstreamErrorDetails(providerResponse, upstreamProviderMessage(providerResponse)),
		)
	}
	if *result.Code != 200 {
		detail := fallbackText(redactUpstreamSecrets(firstNonBlank(result.Msg, result.Data), []string{token}), serverText(locale, "service.pushplusResponseInvalid"))
		return newNotificationChannelError(
			channelHTTPErrorMessage(locale, "PushPlus", resp.StatusCode, detail),
			createUpstreamErrorDetails(providerResponse, detail),
		)
	}
	return nil
}

func postServerChanJSON(endpoint string, payload serverChanSendRequest, locale appLocale, sendKey string) (*http.Response, error) {
	return postJSON(endpoint, payload, "ServerChan", locale, sendKey)
}

func buildServerChanEndpoint(sendKey string, locale appLocale) (string, error) {
	sendKey = strings.TrimSpace(sendKey)
	if strings.HasPrefix(sendKey, "sctp") {
		// sctp SendKey 的数字子域名来自官方 Go SDK 和 Wallos 兼容实现，不允许用户配置任意 URL。
		matches := serverChanSCTPSendKeyRe.FindStringSubmatch(sendKey)
		if len(matches) != 2 {
			return "", errors.New(serverText(locale, "service.serverchanSendKeyInvalid"))
		}
		return fmt.Sprintf("https://%s.push.ft07.com/send/%s.send", matches[1], url.PathEscape(sendKey)), nil
	}
	return fmt.Sprintf("https://sctapi.ftqq.com/%s.send", url.PathEscape(sendKey)), nil
}

func requireServerChanSuccess(resp *http.Response, locale appLocale, sendKey string) error {
	if resp == nil {
		return channelHTTPError(locale, "ServerChan", 0, "")
	}
	providerResponse, rawBody, err := captureUpstreamProviderResponse(resp, []string{sendKey})
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail := redactUpstreamSecrets(firstNonBlank(serverChanJSONErrorDetail([]byte(rawBody)), upstreamProviderMessage(providerResponse), serverText(locale, "service.serverchanResponseInvalid")), []string{sendKey})
		return newNotificationChannelError(
			channelHTTPErrorMessage(locale, "ServerChan", resp.StatusCode, detail),
			createUpstreamErrorDetails(providerResponse, detail),
		)
	}
	var result serverChanSendResponse
	if err := json.Unmarshal([]byte(rawBody), &result); err != nil {
		return newNotificationChannelError(
			channelHTTPErrorMessage(locale, "ServerChan", resp.StatusCode, fallbackText(upstreamProviderMessage(providerResponse), serverText(locale, "service.serverchanResponseInvalid"))),
			createUpstreamErrorDetails(providerResponse, upstreamProviderMessage(providerResponse)),
		)
	}
	// Server酱可能 HTTP 2xx 但业务 code 失败；历史摘要必须按 code 判断真实发送结果。
	if result.Code == nil {
		return newNotificationChannelError(
			channelHTTPErrorMessage(locale, "ServerChan", resp.StatusCode, serverText(locale, "service.serverchanResponseInvalid")),
			createUpstreamErrorDetails(providerResponse, upstreamProviderMessage(providerResponse)),
		)
	}
	if *result.Code != 0 {
		detail := fallbackText(redactUpstreamSecrets(firstNonBlank(result.Message, result.Detail), []string{sendKey}), serverText(locale, "service.serverchanResponseInvalid"))
		return newNotificationChannelError(
			channelHTTPErrorMessage(locale, "ServerChan", resp.StatusCode, detail),
			createUpstreamErrorDetails(providerResponse, detail),
		)
	}
	return nil
}

func serverChanJSONErrorDetail(body []byte) string {
	var result serverChanSendResponse
	if err := json.Unmarshal(body, &result); err == nil {
		return trimLongText(firstNonBlank(result.Message, result.Detail))
	}
	return ""
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func webhookSecrets(endpoint string, headers map[string]string) []string {
	secrets := []string{endpoint}
	for key, value := range headers {
		normalized := strings.ToLower(strings.TrimSpace(key))
		if normalized == "authorization" ||
			strings.Contains(normalized, "secret") ||
			strings.Contains(normalized, "token") ||
			strings.Contains(normalized, "signature") ||
			strings.Contains(normalized, "credential") ||
			strings.Contains(normalized, "api-key") {
			secrets = append(secrets, value)
		}
	}
	return secrets
}
