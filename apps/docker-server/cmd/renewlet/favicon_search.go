package main

// favicon_search.go 为 Logo Resolver 生成确定性网站/favicon 备用候选。
//
// 架构位置：favicon 只作为用户主动搜索的弱候选，不参与导入自动分配。
// Docker 版不再在请求路径上抓 Google/Brave/外部 HTML，和 Cloudflare 保持同一安全边界。
import (
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// mediaRateBucket 是按用户/IP 维度的内存限流桶。
type mediaRateBucket struct {
	Count   int
	ResetAt time.Time
}

type faviconCandidateDomain struct {
	Domain string
	Direct bool
}

var (
	mediaRateLimitMu   sync.Mutex
	mediaRateLimitData = map[string]mediaRateBucket{}
)

func generateFaviconCandidates(kind string, name string, website string, limit int) []mediaCandidate {
	if limit <= 0 {
		return []mediaCandidate{}
	}
	fallbackTlds := mediaResolverCfg.Favicon.FallbackTLDs[kind]
	if len(fallbackTlds) == 0 {
		fallbackTlds = mediaResolverCfg.Favicon.FallbackTLDs["icon"]
	}
	domains := buildFaviconCandidateDomains(name, website, fallbackTlds)
	if len(domains) > mediaResolverCfg.Limits.MaxCandidateDomains {
		domains = domains[:mediaResolverCfg.Limits.MaxCandidateDomains]
	}
	candidates := make([]mediaCandidate, 0, minInt(limit, len(domains)*len(mediaResolverCfg.Favicon.Providers)))
	for _, domain := range domains {
		providers := mediaResolverCfg.Favicon.Providers
		if domain.Direct {
			// 用户显式提供的域名可多试几个标准静态路径；推断域名保持低预算，避免弱候选挤占搜索结果。
			providers = mediaResolverCfg.Favicon.ExplicitProviders
		}
		for _, candidate := range faviconCandidatesForDomain(kind, domain.Domain, providers, len(candidates)) {
			candidates = append(candidates, candidate)
			if len(candidates) >= limit {
				return candidates
			}
		}
	}
	return candidates
}

func faviconCandidatesForDomain(kind string, domain string, providers []faviconProviderConfig, rankOffset int) []mediaCandidate {
	out := make([]mediaCandidate, 0, len(providers))
	for index, item := range providers {
		rank := rankOffset + index
		out = append(out, mediaCandidate{
			ID:             fmt.Sprintf("favicon:%s:%s:%d", item.Provider, domain, rank),
			Kind:           kind,
			Source:         "favicon",
			Provider:       item.Provider,
			Label:          domain,
			Variant:        nil,
			URL:            strings.ReplaceAll(item.URLTemplate, "{domain}", domain),
			Confidence:     "weak",
			AutoAssignable: false,
			MatchedQuery:   domain,
			Rank:           rank,
		})
	}
	return out
}

// buildFaviconCandidateDomains 从网站字段和搜索词推导可能的品牌域名。
func buildFaviconCandidateDomains(query string, website string, fallbackTlds []string) []faviconCandidateDomain {
	domains := []faviconCandidateDomain{}
	if domain := extractDomainFromQuery(query); domain != "" {
		domains = append(domains, faviconCandidateDomain{Domain: domain, Direct: true})
	}
	if domain := extractDomainFromQuery(website); domain != "" {
		domains = append(domains, faviconCandidateDomain{Domain: domain, Direct: true})
	}
	queries := faviconMediaQueries(query)
	for _, reduced := range queries {
		keyword := normalizeFaviconKeyword(reduced)
		if !usableFaviconKeyword(keyword) {
			continue
		}
		if known, ok := mediaResolverCfg.Favicon.KnownDomains[keyword]; ok {
			domains = append(domains, faviconCandidateDomain{Domain: known})
		}
	}
	for _, reduced := range queries {
		keyword := normalizeFaviconKeyword(reduced)
		if !usableFaviconKeyword(keyword) {
			continue
		}
		for _, tld := range fallbackTlds {
			if tld = strings.TrimSpace(tld); tld != "" {
				domains = append(domains, faviconCandidateDomain{Domain: keyword + "." + tld})
			}
		}
	}
	return normalizeCandidateDomains(domains)
}

func faviconMediaQueries(query string) []string {
	queries := reducedMediaQueries(query)
	tokens := mediaQueryTokens(query)
	if len(tokens) <= 1 {
		return queries
	}
	if _, ok := searchModifierSuffixWords[tokens[len(tokens)-1]]; !ok {
		return queries
	}
	brandLength := len(tokens)
	for brandLength > 1 {
		if _, ok := searchModifierSuffixWords[tokens[brandLength-1]]; !ok {
			break
		}
		brandLength--
	}
	out := []string{strings.Join(tokens[:brandLength], " ")}
	out = append(out, queries...)
	return uniqueStrings(out)
}

func usableFaviconKeyword(keyword string) bool {
	return len([]rune(keyword)) >= mediaResolverCfg.Search.MinReducedQueryLength
}

func normalizeCandidateDomains(domains []faviconCandidateDomain) []faviconCandidateDomain {
	out := []faviconCandidateDomain{}
	seen := map[string]struct{}{}
	pushDomain := func(domain string, direct bool) {
		domain = strings.ToLower(strings.TrimSpace(domain))
		if domain == "" {
			return
		}
		if _, ok := seen[domain]; !ok {
			seen[domain] = struct{}{}
			out = append(out, faviconCandidateDomain{Domain: domain, Direct: direct})
		}
	}
	for _, item := range domains {
		domain := strings.ToLower(strings.TrimSpace(item.Domain))
		if domain == "" {
			continue
		}
		pushDomain(domain, item.Direct)
		parts := strings.Split(domain, ".")
		if len(parts) == 2 && !strings.HasPrefix(domain, "www.") {
			pushDomain("www."+domain, item.Direct)
		}
	}
	return out
}

func normalizeFaviconKeyword(input string) string {
	return strings.ToLower(strings.Join(strings.Fields(input), ""))
}

func extractDomainFromQuery(input string) string {
	input = strings.TrimSpace(input)
	if input == "" {
		return ""
	}
	if strings.HasPrefix(input, "http://") || strings.HasPrefix(input, "https://") {
		parsed, err := url.Parse(input)
		if err != nil {
			return ""
		}
		return parsed.Hostname()
	}
	host := strings.ToLower(strings.Split(input, "/")[0])
	// 只接受普通域名形态，不解析裸 IP/端口；这里是 favicon 候选生成，不应扩大成通用 URL 解析器。
	if matched, _ := regexp.MatchString(`^[a-z0-9.-]+\.[a-z]{2,}$`, host); matched {
		return host
	}
	return ""
}

func checkMediaCandidateRateLimit(e *core.RequestEvent) int {
	maxRequests := envInt("MEDIA_CANDIDATE_RATE_LIMIT_MAX", envInt("FAVICON_SEARCH_RATE_LIMIT_MAX", mediaResolverCfg.RateLimit.DefaultMaxRequests))
	windowMs := envInt("MEDIA_CANDIDATE_RATE_LIMIT_WINDOW_MS", envInt("FAVICON_SEARCH_RATE_LIMIT_WINDOW_MS", mediaResolverCfg.RateLimit.DefaultWindowMs))
	if maxRequests <= 0 || windowMs <= 0 || e.Auth == nil {
		return 0
	}
	key := e.Auth.Id + ":" + clientIP(e.Request)
	now := time.Now()

	mediaRateLimitMu.Lock()
	defer mediaRateLimitMu.Unlock()

	bucket := mediaRateLimitData[key]
	if bucket.ResetAt.IsZero() || now.After(bucket.ResetAt) {
		mediaRateLimitData[key] = mediaRateBucket{Count: 1, ResetAt: now.Add(time.Duration(windowMs) * time.Millisecond)}
		return 0
	}
	if bucket.Count >= maxRequests {
		return maxInt(1, int(time.Until(bucket.ResetAt).Seconds()))
	}
	bucket.Count++
	mediaRateLimitData[key] = bucket
	return 0
}

// clientIP 从代理头或 RemoteAddr 提取客户端 IP。
func clientIP(req *http.Request) string {
	if forwarded := strings.TrimSpace(req.Header.Get("x-forwarded-for")); forwarded != "" {
		return strings.TrimSpace(strings.Split(forwarded, ",")[0])
	}
	if realIP := strings.TrimSpace(req.Header.Get("x-real-ip")); realIP != "" {
		return realIP
	}
	host := req.RemoteAddr
	if idx := strings.LastIndex(host, ":"); idx > -1 {
		return host[:idx]
	}
	return host
}

// setPrivateShortCache 设置用户私有短缓存。
// 浏览器 session 只走 cookie；短私有缓存必须按 Cookie 隔离，Public API bearer 不进入这里。
func setPrivateShortCache(e *core.RequestEvent) {
	e.Response.Header().Set("Cache-Control", "private, max-age=300")
	e.Response.Header().Set("Vary", "Cookie")
}

func uniqueStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func minInt(a int, b int) int {
	if a < b {
		return a
	}
	return b
}

func setRetryAfter(e *core.RequestEvent, retryAfter int) {
	e.Response.Header().Set("Retry-After", strconv.Itoa(retryAfter))
}
