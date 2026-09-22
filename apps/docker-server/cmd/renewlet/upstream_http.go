package main

// upstream_http.go 是 Docker/Go 运行面的主动上游请求边界。
//
// 这里统一保留环境代理、TLS 下限、超时、响应体生命周期和 Full redacted 诊断；调用点只传 provider
// 名称与本次请求 secret，避免通知、AI、GitHub、云备份各自拼出不同且容易泄密的网络错误。
import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	defaultUpstreamHTTPTimeout      = 10 * time.Second
	upstreamRequestBodySummaryRunes = 4096
)

var upstreamDiagnosticURLRe = regexp.MustCompile(`https?://[^\s<>"'` + "`" + `]+`)

var upstreamProxyEnvSpecs = []struct {
	name     string
	proxyURL bool
}{
	{name: "HTTP_PROXY", proxyURL: true},
	{name: "HTTPS_PROXY", proxyURL: true},
	{name: "NO_PROXY", proxyURL: false},
	{name: "http_proxy", proxyURL: true},
	{name: "https_proxy", proxyURL: true},
	{name: "no_proxy", proxyURL: false},
}

type upstreamHTTPRequestOptions struct {
	Provider string
	Timeout  time.Duration
	Secrets  []string
	Client   *http.Client
	Body     []byte
}

type upstreamHTTPProxyEnvironmentSummary struct {
	Variables           []string
	CredentialVariables []string
	LoopbackVariables   []string
}

func defaultUpstreamHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout:   normalizeUpstreamHTTPTimeout(timeout),
		Transport: defaultUpstreamHTTPTransport(),
	}
}

func defaultUpstreamHTTPTransport() *http.Transport {
	if base, ok := http.DefaultTransport.(*http.Transport); ok {
		transport := base.Clone()
		// 自定义 Transport 会覆盖 Go 默认代理策略；显式补回环境代理，但实际是否代理仍交给 ProxyFromEnvironment 按 scheme 和 NO_PROXY 决定。
		transport.Proxy = http.ProxyFromEnvironment
		if transport.TLSClientConfig == nil {
			transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
		} else {
			tlsConfig := transport.TLSClientConfig.Clone()
			if tlsConfig.MinVersion == 0 || tlsConfig.MinVersion < tls.VersionTLS12 {
				tlsConfig.MinVersion = tls.VersionTLS12
			}
			transport.TLSClientConfig = tlsConfig
		}
		return transport
	}
	return &http.Transport{
		Proxy:           http.ProxyFromEnvironment,
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
	}
}

func logUpstreamHTTPProxyEnvironment(logger *slog.Logger) {
	summary := upstreamHTTPProxyEnvironmentSummaryFromEnv()
	if len(summary.Variables) == 0 {
		return
	}
	if logger == nil {
		logger = slog.Default()
	}
	// Docker 代理变量可能携带账号密码；启动日志只暴露变量名和凭据存在性，不打印具体地址。
	logger.Info("Docker/Go upstream HTTP proxy environment detected",
		"variables", strings.Join(summary.Variables, ","),
		"credentials", summary.credentialsStatus(),
	)
	if len(summary.LoopbackVariables) > 0 {
		logger.Warn("Docker/Go upstream HTTP proxy uses a loopback address; inside a container, loopback points to the container itself",
			"variables", strings.Join(summary.LoopbackVariables, ","),
		)
	}
}

func upstreamHTTPProxyEnvironmentSummaryFromEnv() upstreamHTTPProxyEnvironmentSummary {
	summary := upstreamHTTPProxyEnvironmentSummary{}
	// 摘要只为启动诊断服务：记录“配置存在”和 loopback 风险，不在日志里复原代理 URL。
	for _, spec := range upstreamProxyEnvSpecs {
		value := strings.TrimSpace(os.Getenv(spec.name))
		if value == "" {
			continue
		}
		summary.Variables = append(summary.Variables, spec.name)
		if !spec.proxyURL {
			continue
		}
		if upstreamProxyEnvValueHasCredentials(value) {
			summary.CredentialVariables = append(summary.CredentialVariables, spec.name)
		}
		if upstreamProxyEnvValueUsesLoopback(value) {
			summary.LoopbackVariables = append(summary.LoopbackVariables, spec.name)
		}
	}
	return summary
}

func (summary upstreamHTTPProxyEnvironmentSummary) credentialsStatus() string {
	if len(summary.CredentialVariables) > 0 {
		return "present"
	}
	return "absent"
}

func upstreamProxyEnvValueHasCredentials(value string) bool {
	parsed, ok := parseUpstreamProxyEnvURL(value)
	return ok && parsed.User != nil
}

func upstreamProxyEnvValueUsesLoopback(value string) bool {
	parsed, ok := parseUpstreamProxyEnvURL(value)
	if !ok {
		return false
	}
	host := strings.ToLower(strings.TrimSpace(parsed.Hostname()))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func parseUpstreamProxyEnvURL(value string) (*url.URL, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, false
	}
	parsed, err := url.Parse(value)
	if err == nil && parsed.Scheme != "" && parsed.Host != "" {
		return parsed, true
	}
	if strings.Contains(value, "://") {
		return nil, false
	}
	// Go 的环境代理允许裸 host[:port]；补 scheme 只用于安全摘要解析，不改变真正请求的代理选择。
	parsed, err = url.Parse("http://" + value)
	if err != nil || parsed.Host == "" {
		return nil, false
	}
	return parsed, true
}

func sendUpstreamRequestBytes(method, endpoint string, headers http.Header, body []byte, options upstreamHTTPRequestOptions) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequest(method, endpoint, reader)
	if err != nil {
		return nil, err
	}
	for key, values := range headers {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	options.Body = body
	return sendUpstreamHTTPRequest(request, options)
}

func sendUpstreamHTTPRequest(request *http.Request, options upstreamHTTPRequestOptions) (*http.Response, error) {
	if request == nil {
		return nil, errors.New("upstream request is nil")
	}
	client := options.Client
	if client == nil {
		client = defaultUpstreamHTTPClient(options.Timeout)
	}
	timeout := upstreamEffectiveTimeout(options.Timeout, client)
	ctx, cancel := context.WithTimeout(request.Context(), timeout)
	next := request.WithContext(ctx)
	response, err := client.Do(next)
	if err != nil {
		cancel()
		timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded) || upstreamNetErrorTimedOut(err)
		return nil, newUpstreamTransportError(upstreamTransportDiagnosticMessage(next, options, err, timeout, timedOut), timedOut)
	}
	if response == nil || response.Body == nil {
		cancel()
		return response, nil
	}
	// 不能在收到 headers 后立即 cancel；调用方还需要读取失败 body 或 drain 成功 body 来复用连接。
	response.Body = upstreamCancelOnCloseReadCloser{ReadCloser: response.Body, cancel: cancel}
	return response, nil
}

type upstreamCancelOnCloseReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (body upstreamCancelOnCloseReadCloser) Close() error {
	err := body.ReadCloser.Close()
	body.cancel()
	return err
}

func upstreamTransportDiagnosticMessage(request *http.Request, options upstreamHTTPRequestOptions, err error, timeout time.Duration, timedOut bool) string {
	provider := strings.TrimSpace(options.Provider)
	if provider == "" {
		provider = "Upstream"
	}
	method := "GET"
	if request != nil && strings.TrimSpace(request.Method) != "" {
		method = strings.ToUpper(strings.TrimSpace(request.Method))
	}
	target := redactedUpstreamRequestTarget(request, options.Secrets)
	var summary string
	if timedOut {
		summary = provider + " " + method + " request to " + target + " timed out after " + upstreamDurationText(timeout) + " before response headers"
	} else {
		summary = provider + " " + method + " request to " + target + " failed before response headers: " + redactedUpstreamTransportError(err, options.Secrets)
	}
	parts := []string{summary}
	if headers := redactedUpstreamRequestHeaders(request, options.Secrets); headers != "" {
		parts = append(parts, "headers="+headers)
	}
	if body := redactedUpstreamRequestBody(options.Body, options.Secrets); body != "" {
		parts = append(parts, "body="+body)
	}
	// 诊断文本只随当前请求进入 rawResponseText；不能写入 lastError、日志、导出或备份。
	return strings.Join(parts, "; ")
}

func redactedUpstreamRequestTarget(request *http.Request, secrets []string) string {
	if request == nil || request.URL == nil {
		return "unknown target"
	}
	parsed := *request.URL
	pathSegments := strings.Split(parsed.EscapedPath(), "/")
	for i, segment := range pathSegments {
		pathSegments[i] = redactedUpstreamPathSegment(segment, secrets)
	}
	path := strings.Join(pathSegments, "/")
	if path == "" {
		path = "/"
	}
	// 保留 host/path/query 才能排查运行面偏移；签名 query 和 token segment 在这里统一脱敏。
	query := redactedUpstreamQuery(parsed.Query(), secrets)
	return parsed.Scheme + "://" + parsed.Host + path + query
}

func redactedUpstreamRequestHeaders(request *http.Request, secrets []string) string {
	if request == nil || len(request.Header) == 0 {
		return ""
	}
	visible := map[string]string{}
	for key, values := range request.Header {
		name := strings.ToLower(strings.TrimSpace(key))
		if name == "" {
			continue
		}
		if !safeUpstreamHeaderName(name) {
			// Header 采用 deny-by-default：未知鉴权、签名和 cookie 名只显示存在性，不回显值。
			visible[name] = "[redacted]"
			continue
		}
		value := truncateUpstreamDiagnostic(redactUpstreamSecrets(strings.TrimSpace(strings.Join(values, ", ")), secrets), 512)
		if value != "" {
			visible[name] = value
		}
	}
	if len(visible) == 0 {
		return ""
	}
	data, err := json.Marshal(visible)
	if err != nil {
		return ""
	}
	return string(data)
}

func redactedUpstreamRequestBody(body []byte, secrets []string) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return ""
	}
	var value interface{}
	if err := json.Unmarshal([]byte(text), &value); err == nil {
		// JSON 请求体保留结构用于定位错误字段，递归脱敏后才允许进入诊断文本。
		data, err := json.Marshal(redactedUpstreamJSONValue(value, secrets))
		if err == nil {
			return truncateUpstreamDiagnostic(string(data), upstreamRequestBodySummaryRunes)
		}
	}
	return truncateUpstreamDiagnostic(redactUpstreamSecrets(text, secrets), upstreamRequestBodySummaryRunes)
}

func redactedUpstreamPathSegment(segment string, secrets []string) string {
	if segment == "" {
		return segment
	}
	decoded, err := url.PathUnescape(segment)
	if err != nil {
		decoded = segment
	}
	if sensitiveUpstreamDiagnosticKey(decoded) || upstreamSegmentMatchesSecret(decoded, secrets) {
		return "[redacted]"
	}
	return redactUpstreamSecrets(segment, secrets)
}

func redactedUpstreamQuery(values url.Values, secrets []string) string {
	if len(values) == 0 {
		return ""
	}
	next := url.Values{}
	for key, items := range values {
		for _, item := range items {
			if sensitiveUpstreamDiagnosticKey(key) {
				next.Add(key, "[redacted]")
			} else {
				next.Add(key, redactUpstreamSecrets(item, secrets))
			}
		}
	}
	return "?" + next.Encode()
}

func redactedUpstreamJSONValue(value interface{}, secrets []string) interface{} {
	switch typed := value.(type) {
	case string:
		return redactUpstreamSecrets(typed, secrets)
	case []interface{}:
		out := make([]interface{}, 0, len(typed))
		for _, item := range typed {
			out = append(out, redactedUpstreamJSONValue(item, secrets))
		}
		return out
	case map[string]interface{}:
		out := make(map[string]interface{}, len(typed))
		for key, item := range typed {
			if sensitiveUpstreamDiagnosticKey(key) {
				out[key] = "[redacted]"
			} else {
				out[key] = redactedUpstreamJSONValue(item, secrets)
			}
		}
		return out
	default:
		return value
	}
}

func redactedUpstreamTransportError(err error, secrets []string) string {
	if err == nil {
		return "network error"
	}
	message := upstreamDiagnosticURLRe.ReplaceAllStringFunc(err.Error(), func(match string) string {
		parsed, parseErr := url.Parse(match)
		if parseErr != nil {
			return "[redacted-url]"
		}
		return redactedUpstreamRequestTarget(&http.Request{URL: parsed}, secrets)
	})
	message = redactUpstreamSecrets(message, secrets)
	if strings.TrimSpace(message) == "" {
		return "network error"
	}
	return truncateUpstreamDiagnostic(message, upstreamRequestBodySummaryRunes)
}

func upstreamSegmentMatchesSecret(segment string, secrets []string) bool {
	for _, secret := range normalizedUpstreamSecrets(secrets) {
		if segment == secret {
			return true
		}
		if unescaped, err := url.PathUnescape(secret); err == nil && segment == unescaped {
			return true
		}
	}
	return false
}

func sensitiveUpstreamDiagnosticKey(value string) bool {
	normalized := strings.ToLower(strings.NewReplacer("_", "", "-", "", " ", "").Replace(strings.TrimSpace(value)))
	if normalized == "" {
		return false
	}
	if normalized == "key" || normalized == "sign" || normalized == "sendkey" || normalized == "cookie" || normalized == "setcookie" {
		return true
	}
	for _, marker := range []string{"authorization", "password", "passwd", "secret", "token", "signature", "credential", "accesskey", "apikey", "authkey"} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

func upstreamNetErrorTimedOut(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func upstreamEffectiveTimeout(timeout time.Duration, client *http.Client) time.Duration {
	out := normalizeUpstreamHTTPTimeout(timeout)
	if client != nil && client.Timeout > 0 && client.Timeout < out {
		out = client.Timeout
	}
	return out
}

func normalizeUpstreamHTTPTimeout(timeout time.Duration) time.Duration {
	if timeout <= 0 {
		return defaultUpstreamHTTPTimeout
	}
	return timeout
}

func upstreamDurationText(duration time.Duration) string {
	if duration > 0 && duration%time.Second == 0 {
		return strings.TrimSuffix(duration.String(), ".0")
	}
	return duration.String()
}

func truncateUpstreamDiagnostic(value string, limit int) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit]) + "..."
}
