package main

// app_store_icon_search.go 是 Docker/Go 运行面的 App Store Logo 候选来源。
//
// Apple Search API 返回应用元数据和 artwork URL，不返回图片文件；Renewlet 只缓存窄 JSON，
// 不下载、不转存 Apple CDN 图标，最终仍由用户手动选择外链 URL 后持久化。
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// App Store 是共享外部出口；小 limit、短超时和有界 body 共同保证手动 Logo 搜索不会拖垮候选 API。
	appStoreIconSearchURL            = "https://itunes.apple.com/search"
	appStoreIconFetchTimeout         = 2 * time.Second
	appStoreIconCountryLimit         = 3
	appStoreIconResponseLimitBytes   = 256 * 1024
	appStoreIconFreshTTL             = 24 * time.Hour
	appStoreIconStaleTTL             = 7 * 24 * time.Hour
	appStoreIconCacheMaxEntries      = 512
	appStoreIconProvider             = "appStore"
	appStoreIconHTTPProviderLabel    = "Apple Search API"
	appStoreIconCandidateSource      = "appStore"
	appStoreIconCandidateIDPrefix    = "appstore"
	appStoreIconDefaultMatchedSuffix = "app-store"
)

var (
	appStoreIconHTTPClient = defaultUpstreamHTTPClient(appStoreIconFetchTimeout)
	appStoreIconsCache     = newAppStoreIconSearchCache(appStoreIconCacheMaxEntries)
)

type appStoreAPIResponse struct {
	ResultCount int                 `json:"resultCount"`
	Results     []appStoreAPIResult `json:"results"`
}

type appStoreAPIResult struct {
	TrackID       int64  `json:"trackId"`
	TrackName     string `json:"trackName"`
	SellerName    string `json:"sellerName"`
	BundleID      string `json:"bundleId"`
	ArtworkURL512 string `json:"artworkUrl512"`
	ArtworkURL100 string `json:"artworkUrl100"`
	ArtworkURL60  string `json:"artworkUrl60"`
	TrackViewURL  string `json:"trackViewUrl"`
}

type appStoreCountryResult struct {
	country string
	results []appStoreAPIResult
	err     error
}

type appStoreIconCacheEntry struct {
	results   []appStoreAPIResult
	fetchedAt time.Time
}

type appStoreIconPendingSearch struct {
	done    chan struct{}
	results []appStoreAPIResult
	err     error
}

type appStoreIconSearchCache struct {
	mu         sync.Mutex
	entries    map[string]appStoreIconCacheEntry
	accessKeys []string
	pending    map[string]*appStoreIconPendingSearch
	maxEntries int
}

func newAppStoreIconSearchCache(maxEntries int) *appStoreIconSearchCache {
	return &appStoreIconSearchCache{
		entries:    map[string]appStoreIconCacheEntry{},
		pending:    map[string]*appStoreIconPendingSearch{},
		maxEntries: maxEntries,
	}
}

func searchAppStoreIconCandidates(ctx context.Context, kind string, query string, limit int, storefronts []string) ([]mediaCandidate, error) {
	if kind != "logo" || limit <= 0 {
		return []mediaCandidate{}, nil
	}
	normalizedQuery := normalizeMediaTerm(query)
	if normalizedQuery == "" || isPlanOnlyQuery(normalizedQuery) {
		return []mediaCandidate{}, nil
	}
	// 默认只查 US，把 CN 作为显式勾选项，避免一次手动搜索无意中消耗两次 Apple 限流额度。
	storefronts = appStoreStorefrontsOrDefault(storefronts)

	// 2 秒超时覆盖所选地区的整轮查询；双区只在用户勾选后并发，不能把 Apple 慢响应传导到整页搜索。
	ctx, cancel := context.WithTimeout(ctx, appStoreIconFetchTimeout)
	defer cancel()

	resultsCh := make(chan appStoreCountryResult, len(storefronts))
	var wg sync.WaitGroup
	for _, country := range storefronts {
		country := country
		wg.Add(1)
		go func() {
			defer wg.Done()
			results, err := appStoreIconsCache.lookup(ctx, normalizedQuery, country)
			resultsCh <- appStoreCountryResult{country: country, results: results, err: err}
		}()
	}
	wg.Wait()
	close(resultsCh)

	countryResults := make([]appStoreCountryResult, 0, len(storefronts))
	var firstErr error
	for result := range resultsCh {
		if result.err != nil && firstErr == nil {
			firstErr = result.err
		}
		countryResults = append(countryResults, result)
	}
	sort.SliceStable(countryResults, func(i, j int) bool {
		return appStoreCountryRank(countryResults[i].country) < appStoreCountryRank(countryResults[j].country)
	})
	candidates := appStoreResultsToCandidates(kind, normalizedQuery, countryResults, limit)
	if len(candidates) > 0 {
		return candidates, nil
	}
	return []mediaCandidate{}, firstErr
}

func (cache *appStoreIconSearchCache) lookup(ctx context.Context, normalizedQuery string, country string) ([]appStoreAPIResult, error) {
	// country 是唯一的请求放大维度；按 query+country 缓存和合并，避免 CN 命中污染默认 US 结果排序。
	key := appStoreCacheKey(normalizedQuery, country)
	now := time.Now()

	cache.mu.Lock()
	if entry, ok := cache.entries[key]; ok && now.Sub(entry.fetchedAt) <= appStoreIconFreshTTL {
		cache.touchLocked(key)
		results := cloneAppStoreAPIResults(entry.results)
		cache.mu.Unlock()
		return results, nil
	}
	pending := cache.pending[key]
	if pending != nil {
		cache.mu.Unlock()
		select {
		case <-pending.done:
			return cloneAppStoreAPIResults(pending.results), pending.err
		case <-ctx.Done():
			return cache.staleOrError(key, ctx.Err())
		}
	}
	pending = &appStoreIconPendingSearch{done: make(chan struct{})}
	cache.pending[key] = pending
	cache.mu.Unlock()

	// Apple 官方建议压低 limit 并缓存结果；这里按 storefront 缓存窄结果，避免手动搜索重复撞共享出口限流。
	results, err := fetchAppStoreIconResults(ctx, normalizedQuery, country)
	if err != nil {
		if stale, ok := cache.stale(key); ok {
			results = stale
			err = nil
		}
	}

	cache.mu.Lock()
	if err == nil {
		cache.entries[key] = appStoreIconCacheEntry{results: cloneAppStoreAPIResults(results), fetchedAt: now}
		cache.touchLocked(key)
		cache.evictLocked()
	}
	pending.results = cloneAppStoreAPIResults(results)
	pending.err = err
	delete(cache.pending, key)
	close(pending.done)
	cache.mu.Unlock()

	return cloneAppStoreAPIResults(results), err
}

func (cache *appStoreIconSearchCache) staleOrError(key string, fallback error) ([]appStoreAPIResult, error) {
	if results, ok := cache.stale(key); ok {
		return results, nil
	}
	return nil, fallback
}

func (cache *appStoreIconSearchCache) stale(key string) ([]appStoreAPIResult, bool) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	entry, ok := cache.entries[key]
	if !ok || time.Since(entry.fetchedAt) > appStoreIconStaleTTL {
		return nil, false
	}
	// stale 只返回已清洗的窄字段；Apple 原始 body 不进入进程缓存、日志或 settings。
	cache.touchLocked(key)
	return cloneAppStoreAPIResults(entry.results), true
}

func (cache *appStoreIconSearchCache) touchLocked(key string) {
	for index, item := range cache.accessKeys {
		if item == key {
			cache.accessKeys = append(cache.accessKeys[:index], cache.accessKeys[index+1:]...)
			break
		}
	}
	cache.accessKeys = append(cache.accessKeys, key)
}

func (cache *appStoreIconSearchCache) evictLocked() {
	for cache.maxEntries > 0 && len(cache.entries) > cache.maxEntries && len(cache.accessKeys) > 0 {
		key := cache.accessKeys[0]
		cache.accessKeys = cache.accessKeys[1:]
		delete(cache.entries, key)
	}
}

func fetchAppStoreIconResults(ctx context.Context, normalizedQuery string, country string) ([]appStoreAPIResult, error) {
	// 只用固定官方 Search API endpoint；用户输入只能进入 url.Values，不能变成任意上游 URL。
	endpoint, err := url.Parse(appStoreIconSearchURL)
	if err != nil {
		return nil, err
	}
	params := url.Values{}
	params.Set("term", normalizedQuery)
	params.Set("country", country)
	params.Set("media", "software")
	params.Set("entity", "software")
	params.Set("limit", strconv.Itoa(appStoreIconCountryLimit))
	endpoint.RawQuery = params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Renewlet/"+Version)
	res, err := sendUpstreamHTTPRequest(req, upstreamHTTPRequestOptions{
		Provider: appStoreIconHTTPProviderLabel,
		Timeout:  appStoreIconFetchTimeout,
		Client:   appStoreIconHTTPClient,
	})
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < http.StatusOK || res.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, appStoreIconResponseLimitBytes+1))
		return nil, fmt.Errorf("%s HTTP %d", appStoreIconHTTPProviderLabel, res.StatusCode)
	}
	// Apple 失败或异常大响应只能让 App Store 分组降级为空，不能占用内存或阻断内置/favicons 结果。
	data, err := io.ReadAll(io.LimitReader(res.Body, appStoreIconResponseLimitBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > appStoreIconResponseLimitBytes {
		return nil, errors.New("Apple Search API response too large")
	}
	var payload appStoreAPIResponse
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	return sanitizeAppStoreAPIResults(payload.Results), nil
}

func appStoreResultsToCandidates(kind string, matchedQuery string, countryResults []appStoreCountryResult, limit int) []mediaCandidate {
	// 双区结果按 app id/bundle/artwork 去重，再按分数与 US->CN 固定顺序排序，避免同一 App 在设置切换后抖动。
	type scoredCandidate struct {
		candidate   mediaCandidate
		score       float64
		countryRank int
		resultIndex int
	}
	byKey := map[string]scoredCandidate{}
	for _, group := range countryResults {
		countryRank := appStoreCountryRank(group.country)
		for resultIndex, result := range group.results {
			artworkURL := appStoreArtworkURL(result)
			if artworkURL == "" {
				continue
			}
			score := scoreAppStoreIconResult(result, matchedQuery)
			if score < mediaResolverCfg.Scores.MediumThreshold {
				continue
			}
			dedupeKey := appStoreDedupeKey(result, artworkURL)
			candidate := appStoreCandidateFromResult(kind, matchedQuery, group.country, result, artworkURL, confidenceFromScore(score), resultIndex)
			current, ok := byKey[dedupeKey]
			if !ok || score > current.score || (score == current.score && (countryRank < current.countryRank || (countryRank == current.countryRank && resultIndex < current.resultIndex))) {
				byKey[dedupeKey] = scoredCandidate{candidate: candidate, score: score, countryRank: countryRank, resultIndex: resultIndex}
			}
		}
	}
	scored := make([]scoredCandidate, 0, len(byKey))
	for _, item := range byKey {
		scored = append(scored, item)
	}
	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].score != scored[j].score {
			return scored[i].score > scored[j].score
		}
		if scored[i].countryRank != scored[j].countryRank {
			return scored[i].countryRank < scored[j].countryRank
		}
		if scored[i].resultIndex != scored[j].resultIndex {
			return scored[i].resultIndex < scored[j].resultIndex
		}
		return scored[i].candidate.Label < scored[j].candidate.Label
	})
	if len(scored) > limit {
		scored = scored[:limit]
	}
	candidates := make([]mediaCandidate, 0, len(scored))
	for index, item := range scored {
		candidate := item.candidate
		candidate.Rank = index
		candidates = append(candidates, candidate)
	}
	return candidates
}

func appStoreCandidateFromResult(kind string, matchedQuery string, country string, result appStoreAPIResult, artworkURL string, confidence string, rank int) mediaCandidate {
	return mediaCandidate{
		ID:             appStoreCandidateID(country, result, artworkURL),
		Kind:           kind,
		Source:         appStoreIconCandidateSource,
		Provider:       appStoreIconProvider,
		Label:          fallbackText(strings.TrimSpace(result.TrackName), strings.TrimSpace(result.SellerName)),
		Variant:        nil,
		URL:            artworkURL,
		Confidence:     confidence,
		AutoAssignable: false,
		MatchedQuery:   fallbackText(matchedQuery, appStoreIconDefaultMatchedSuffix),
		Rank:           rank,
	}
}

func scoreAppStoreIconResult(result appStoreAPIResult, query string) float64 {
	best := 0.0
	compactQuery := compactMediaTerm(query)
	parts := mediaQueryTokens(query)
	for _, term := range []string{result.TrackName, result.SellerName, result.BundleID} {
		normalized := normalizeMediaTerm(term)
		if normalized == "" {
			continue
		}
		compact := compactMediaTerm(normalized)
		if normalized == query || compact == compactQuery {
			best = maxFloat(best, mediaResolverCfg.Scores.Exact)
		} else if strings.HasPrefix(normalized, query) || strings.HasPrefix(compact, compactQuery) {
			best = maxFloat(best, mediaResolverCfg.Scores.Prefix)
		} else if strings.Contains(normalized, query) || strings.Contains(compact, compactQuery) {
			best = maxFloat(best, mediaResolverCfg.Scores.Contains)
		} else if len(parts) > 1 && allPartsIncluded(normalized, parts) {
			best = maxFloat(best, mediaResolverCfg.Scores.AllParts)
		} else if len(compactQuery) >= 4 && isSubsequence(compactQuery, compact) {
			best = maxFloat(best, mediaResolverCfg.Scores.Subsequence)
		}
	}
	return best
}

func appStoreArtworkURL(result appStoreAPIResult) string {
	// 512 字段实测存在但官方稳定口径更偏 60/100；只能按字段兜底选择，不能靠改 URL 字符串猜尺寸。
	for _, value := range []string{result.ArtworkURL512, result.ArtworkURL100, result.ArtworkURL60} {
		value = strings.TrimSpace(value)
		if isSafeAppStoreArtworkURL(value) {
			return value
		}
	}
	return ""
}

func isSafeAppStoreArtworkURL(value string) bool {
	// Apple 元数据仍按不可信输入处理；候选只允许 Apple CDN artwork，拒绝 userinfo 和非 HTTPS URL。
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return host == "mzstatic.com" || strings.HasSuffix(host, ".mzstatic.com")
}

func sanitizeAppStoreAPIResults(results []appStoreAPIResult) []appStoreAPIResult {
	// 进程缓存只保存前端展示需要的窄字段，避免把 Apple raw response 当成可排障持久数据。
	out := make([]appStoreAPIResult, 0, minInt(len(results), appStoreIconCountryLimit))
	for _, result := range results {
		result.TrackName = strings.TrimSpace(result.TrackName)
		result.SellerName = strings.TrimSpace(result.SellerName)
		result.BundleID = strings.TrimSpace(result.BundleID)
		result.ArtworkURL512 = strings.TrimSpace(result.ArtworkURL512)
		result.ArtworkURL100 = strings.TrimSpace(result.ArtworkURL100)
		result.ArtworkURL60 = strings.TrimSpace(result.ArtworkURL60)
		result.TrackViewURL = strings.TrimSpace(result.TrackViewURL)
		if result.TrackName == "" || appStoreArtworkURL(result) == "" {
			continue
		}
		out = append(out, result)
		if len(out) >= appStoreIconCountryLimit {
			break
		}
	}
	return out
}

func appStoreCacheKey(normalizedQuery string, country string) string {
	return normalizedQuery + "\x00" + strings.ToLower(country)
}

func appStoreDedupeKey(result appStoreAPIResult, artworkURL string) string {
	if result.TrackID > 0 {
		return "track:" + strconv.FormatInt(result.TrackID, 10)
	}
	if result.BundleID != "" {
		return "bundle:" + strings.ToLower(result.BundleID)
	}
	return "artwork:" + artworkURL
}

func appStoreCandidateID(country string, result appStoreAPIResult, artworkURL string) string {
	if result.TrackID > 0 {
		return appStoreIconCandidateIDPrefix + ":" + strings.ToLower(country) + ":" + strconv.FormatInt(result.TrackID, 10)
	}
	if result.BundleID != "" {
		return appStoreIconCandidateIDPrefix + ":" + strings.ToLower(country) + ":" + strings.ToLower(result.BundleID)
	}
	return appStoreIconCandidateIDPrefix + ":" + strings.ToLower(country) + ":" + compactMediaTerm(artworkURL)
}

func appStoreCountryRank(country string) int {
	for index, item := range appStoreSupportedStorefronts {
		if item == country {
			return index
		}
	}
	return len(appStoreSupportedStorefronts)
}

func cloneAppStoreAPIResults(results []appStoreAPIResult) []appStoreAPIResult {
	return append([]appStoreAPIResult(nil), results...)
}
