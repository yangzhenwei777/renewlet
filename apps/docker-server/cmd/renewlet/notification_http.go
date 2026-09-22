package main

// notification_http.go 提供外发通知使用的 HTTP/JSON 工具。
//
// 架构位置：渠道发送层统一通过这里设置超时、TLS 下限、错误文本截断和 SSRF DNS 解析校验。
// 这些防护必须靠近网络边界，避免新渠道绕过安全策略。
//
// 注意： responseOK 会消费并关闭响应体；调用方读取错误详情时必须在 responseOK 之前完成。
import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var (
	notificationHTTPClientFactory = defaultNotificationHTTPClient
	// outboundURLResolver 只作为 SSRF 测试注入点；生产仍使用 net.DefaultResolver，不改变 DNS 策略。
	outboundURLResolver = defaultOutboundURLResolver
)

func postJSON[T interface{}](endpoint string, payload T, serviceLabel string, locale appLocale, secrets ...string) (*http.Response, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return sendHTTPRequest(http.MethodPost, endpoint, map[string]string{"content-type": "application/json"}, body, serviceLabel, locale, secrets...)
}

func sendHTTPRequest(method, endpoint string, headers map[string]string, body []byte, serviceLabel string, locale appLocale, secrets ...string) (*http.Response, error) {
	requestHeaders := http.Header{}
	for key, value := range headers {
		requestHeaders.Set(key, value)
	}
	resp, err := sendUpstreamRequestBytes(method, endpoint, requestHeaders, body, upstreamHTTPRequestOptions{
		Provider: serviceLabel,
		Timeout:  10 * time.Second,
		Secrets:  secrets,
		Client:   notificationHTTPClientFactory(),
	})
	if err != nil {
		message := err.Error()
		return nil, newNotificationChannelError(
			serverFormat(locale, "notification.httpRequestFailed", map[string]interface{}{"service": serviceLabel, "error": message}),
			upstreamErrorDetailsFromError(err),
		)
	}
	return resp, nil
}

func defaultNotificationHTTPClient() *http.Client {
	// 用户可配置 URL 必须先过 assertSafeOutboundURL；HTTP client 只统一代理、TLS 和超时策略。
	return defaultUpstreamHTTPClient(10 * time.Second)
}

func channelHTTPError(locale appLocale, channel string, statusCode int, detail string) error {
	return errors.New(channelHTTPErrorMessage(locale, channel, statusCode, detail))
}

func channelHTTPErrorFromResponse(locale appLocale, channel string, resp *http.Response, secrets ...string) error {
	providerResponse, _, err := captureUpstreamProviderResponse(resp, secrets)
	if err != nil {
		return err
	}
	statusCode := 0
	if providerResponse != nil && providerResponse.Status != nil {
		statusCode = *providerResponse.Status
	}
	detail := upstreamProviderMessage(providerResponse)
	if detail == "" && resp != nil {
		detail = resp.Status
	}
	return newNotificationChannelError(
		channelHTTPErrorMessage(locale, channel, statusCode, detail),
		createUpstreamErrorDetails(providerResponse, detail),
	)
}

func channelHTTPErrorMessage(locale appLocale, channel string, statusCode int, detail string) string {
	return serverFormat(locale, "notification.httpSendFailed", map[string]interface{}{"channel": channel, "status": statusCode, "detail": trimLongText(detail)})
}

func responseOK(resp *http.Response) bool {
	if resp == nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false
	}
	if resp.Body != nil {
		// 成功响应也要 drain/close，保证 Go transport 能复用连接，降低连续渠道发送的握手开销。
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}
	return true
}

func trimLongText(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 800 {
		return value[:800] + "..."
	}
	return value
}

func fallbackText(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}

func parseHeaderJSON(input string, locale appLocale) (map[string]string, error) {
	headers := map[string]string{}
	input = strings.TrimSpace(input)
	if input == "" {
		return headers, nil
	}
	var raw map[string]string
	if err := json.Unmarshal([]byte(input), &raw); err != nil {
		return nil, errors.New(serverText(locale, "validation.jsonParseFailed"))
	}
	for key, value := range raw {
		// 只接受 JSON string map，避免复杂 header 值在序列化时绕过 http.Header 的规范化。
		headers[key] = value
	}
	return headers, nil
}

func renderWebhookPayloadTemplate(template string, message notificationMessage, locale appLocale) ([]byte, error) {
	if strings.TrimSpace(template) == "" {
		return json.Marshal(webhookDefaultPayload{
			Title:     message.Title,
			Content:   message.Content,
			Timestamp: message.Timestamp,
		})
	}
	var value interface{}
	decoder := json.NewDecoder(strings.NewReader(template))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, errors.New(serverText(locale, "validation.jsonParseFailed"))
	}
	var extra interface{}
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, errors.New(serverText(locale, "validation.jsonParseFailed"))
	}
	// Webhook 模板必须先作为 JSON 解析，再只替换 string leaf；这样多行正文会由 json.Marshal 负责转义。
	return json.Marshal(renderWebhookTemplateValue(value, message))
}

func renderWebhookTemplateValue(value interface{}, message notificationMessage) interface{} {
	switch typed := value.(type) {
	case string:
		return applyTemplate(typed, message)
	case []interface{}:
		out := make([]interface{}, 0, len(typed))
		for _, item := range typed {
			out = append(out, renderWebhookTemplateValue(item, message))
		}
		return out
	case map[string]interface{}:
		out := make(map[string]interface{}, len(typed))
		for key, item := range typed {
			out[key] = renderWebhookTemplateValue(item, message)
		}
		return out
	default:
		return value
	}
}

func applyTemplate(template string, message notificationMessage) string {
	replacer := strings.NewReplacer(
		"{title}", message.Title,
		"{content}", message.Content,
		"{timestamp}", message.Timestamp,
	)
	return replacer.Replace(template)
}

func splitList(input string) []string {
	parts := strings.FieldsFunc(input, func(r rune) bool {
		return r == ',' || r == '\n' || r == ';'
	})
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// assertSafeOutboundURL 校验外发 URL，防止 SSRF。
// DNS 解析后再检查 IP，是为了拦截域名解析到内网/本机地址的情况。
// TODO： 若未来允许高风险内网部署场景，可改成自定义 DialContext 并固定解析后的 IP，进一步降低 DNS rebinding 窗口。
func assertSafeOutboundURL(rawURL, label string, locale appLocale) (*url.URL, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" || parsed.Hostname() == "" {
		return nil, errors.New(serverFormat(locale, "url.invalid", map[string]interface{}{"label": label}))
	}
	if parsed.Scheme != "https" {
		return nil, errors.New(serverFormat(locale, "url.mustUseHttps", map[string]interface{}{"label": label}))
	}
	if parsed.User != nil {
		// 通知 URL 不接受 userinfo，避免凭据被日志、错误文本或第三方重定向路径带出。
		return nil, errors.New(serverFormat(locale, "url.invalid", map[string]interface{}{"label": label}))
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return nil, errors.New(serverFormat(locale, "url.localhostNotAllowed", map[string]interface{}{"label": label}))
	}
	if ip, ok := parseOutboundIPLiteral(host); ok {
		// URL 解析器会接受十六进制/八进制/整数 IPv4；必须先规范化字面量，再判断私网。
		if isUnsafeOutboundIP(ip) {
			return nil, errors.New(serverFormat(locale, "url.privateOrLocalNotAllowed", map[string]interface{}{"label": label}))
		}
		return parsed, nil
	}
	ips, err := outboundURLResolver(host)
	if err != nil {
		return nil, errors.New(serverFormat(locale, "url.dnsLookupFailed", map[string]interface{}{"label": label}))
	}
	if len(ips) == 0 {
		// 空解析结果不能当作安全，否则后续 HTTP client 的真实解析会绕过当前检查。
		return nil, errors.New(serverFormat(locale, "url.privateOrLocalNotAllowed", map[string]interface{}{"label": label}))
	}
	for _, ip := range ips {
		// 任何一个解析结果落到内网/本机都拒绝，避免服务端在多 A/AAAA 记录中选到危险地址。
		if isUnsafeOutboundIP(ip.IP) {
			return nil, errors.New(serverFormat(locale, "url.privateOrLocalNotAllowed", map[string]interface{}{"label": label}))
		}
	}
	return parsed, nil
}

func defaultOutboundURLResolver(host string) ([]net.IPAddr, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return net.DefaultResolver.LookupIPAddr(ctx, host)
}

func parseOutboundIPLiteral(host string) (net.IP, bool) {
	if ip := net.ParseIP(host); ip != nil {
		return ip, true
	}
	parts := strings.Split(host, ".")
	if len(parts) == 4 {
		octets := make([]byte, 4)
		for i, part := range parts {
			value, ok := parseIPv4Number(part)
			if !ok || value > 255 {
				return nil, false
			}
			octets[i] = byte(value)
		}
		return net.IPv4(octets[0], octets[1], octets[2], octets[3]), true
	}
	if len(parts) == 1 {
		value, ok := parseIPv4Number(host)
		if !ok || value > 0xffffffff {
			return nil, false
		}
		return net.IPv4(byte(value>>24), byte(value>>16), byte(value>>8), byte(value)), true
	}
	return nil, false
}

func parseIPv4Number(value string) (uint64, bool) {
	if value == "" {
		return 0, false
	}
	parsed, err := strconv.ParseUint(value, 0, 32)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

func isUnsafeOutboundIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if mapped := ipv4MappedIPv6(ip); mapped != nil {
		return isUnsafeOutboundIP(mapped)
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified()
}

func ipv4MappedIPv6(ip net.IP) net.IP {
	value := ip.To16()
	if value == nil || ip.To4() != nil {
		return nil
	}
	// ::ffff:7f00:1 这类 IPv4-mapped IPv6 需要按内嵌 IPv4 再判一次私网/本机。
	for i := 0; i < 10; i++ {
		if value[i] != 0 {
			return nil
		}
	}
	if value[10] != 0xff || value[11] != 0xff {
		return nil
	}
	return net.IPv4(value[12], value[13], value[14], value[15])
}
