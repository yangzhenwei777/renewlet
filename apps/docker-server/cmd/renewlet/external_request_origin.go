package main

// external_request_origin.go 收敛 Docker/Go 运行面的外部访问 Origin。
//
// Renewlet 会生成公开状态页和日历订阅这类 bearer URL；在反向代理或 Vite dev proxy 下，
// 浏览器看到的 origin 和 Go 实际监听地址可能不同，所有对外 URL 必须共用这一层解析。
import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode"
)

func externalRequestOrigin(request *http.Request) url.URL {
	return url.URL{
		Scheme: externalRequestProto(request),
		Host:   externalRequestHost(request),
	}
}

func externalRequestURL(request *http.Request, path string, query url.Values) string {
	u := externalRequestOrigin(request)
	u.Path = path
	if query != nil {
		u.RawQuery = query.Encode()
	}
	return u.String()
}

func externalRequestProto(request *http.Request) string {
	if proto := forwardedProto(request.Header.Get("Forwarded")); proto != "" {
		return proto
	}
	if proto := validExternalRequestProto(firstHeaderValue(request.Header.Get("X-Forwarded-Proto"))); proto != "" {
		return proto
	}
	if request.TLS != nil {
		return "https"
	}
	return "http"
}

func externalRequestHost(request *http.Request) string {
	if host := forwardedHost(request.Header.Get("Forwarded")); host != "" {
		return host
	}
	if host := validExternalRequestHost(firstHeaderValue(request.Header.Get("X-Forwarded-Host"))); host != "" {
		return host
	}
	if host := validExternalRequestHost(request.Host); host != "" {
		return host
	}
	return "localhost"
}

func forwardedProto(value string) string {
	return forwardedPart(value, "proto", validExternalRequestProto)
}

func forwardedHost(value string) string {
	return forwardedPart(value, "host", validExternalRequestHost)
}

func forwardedPart(value string, key string, normalize func(string) string) string {
	for _, forwardedValue := range strings.Split(value, ",") {
		for _, part := range strings.Split(forwardedValue, ";") {
			pair := strings.SplitN(strings.TrimSpace(part), "=", 2)
			if len(pair) != 2 || !strings.EqualFold(strings.TrimSpace(pair[0]), key) {
				continue
			}
			if normalized := normalize(forwardedHeaderValue(pair[1])); normalized != "" {
				return normalized
			}
		}
	}
	return ""
}

func forwardedHeaderValue(value string) string {
	return strings.Trim(strings.TrimSpace(value), `"`)
}

func firstHeaderValue(value string) string {
	value = strings.TrimSpace(value)
	if comma := strings.Index(value, ","); comma >= 0 {
		value = value[:comma]
	}
	return strings.TrimSpace(value)
}

func validExternalRequestProto(value string) string {
	proto := strings.ToLower(strings.TrimSpace(value))
	if proto == "http" || proto == "https" {
		return proto
	}
	return ""
}

func validExternalRequestHost(value string) string {
	host := forwardedHeaderValue(value)
	if host == "" || strings.ContainsAny(host, "/\\?#@") {
		return ""
	}
	for _, r := range host {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return ""
		}
	}
	parsed, err := url.Parse("http://" + host)
	if err != nil || parsed.Host != host || parsed.User != nil || parsed.Hostname() == "" {
		return ""
	}
	hostname := parsed.Hostname()
	normalized := hostname
	if strings.Contains(hostname, ":") {
		normalized = "[" + hostname + "]"
	}
	if port := parsed.Port(); port != "" {
		value, err := strconv.Atoi(port)
		if err != nil || value <= 0 || value > 65535 {
			return ""
		}
		normalized += ":" + port
	}
	if normalized != host {
		return ""
	}
	return parsed.Host
}
