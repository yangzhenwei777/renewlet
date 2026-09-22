package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	appstatic "github.com/zhiyingzzhou/renewlet/apps/docker-server/internal/static"
	"golang.org/x/sync/singleflight"
)

const mediaIconIndexRecordKey = "active"
const builtInIconGitHubFetchTimeout = 15 * time.Second
const builtInIconGitHubAtomFeedLimitBytes = 512 * 1024
const builtInIconProviderStatusMaxBytes = 64 * 1024

var builtInIconProviders = []string{"thesvg", "selfhst", "dashboardIcons"}
var builtInIconGitHubBase = "https://github.com"

type builtInIconIndexCacheState struct {
	hash     string
	resolver builtInResolverIndex
}

type encodedBuiltInIconIndex struct {
	hash                  string
	searchIndex           builtInIconSearchIndex
	searchIndexGzipBase64 string
	detailIndexGzipBase64 string
}

type storedBuiltInIconProviderState struct {
	Current     *builtInIconProviderVersionResponse `json:"current,omitempty"`
	Latest      *builtInIconProviderVersionResponse `json:"latest,omitempty"`
	CheckedAt   string                              `json:"checkedAt,omitempty"`
	RefreshedAt string                              `json:"refreshedAt,omitempty"`
	LastError   string                              `json:"lastError,omitempty"`
	ETag        string                              `json:"etag,omitempty"`
}

type storedBuiltInIconProviderStates map[string]storedBuiltInIconProviderState

type builtInIconSeedMetadata struct {
	Hash           string                                         `json:"hash"`
	IconCount      int                                            `json:"iconCount"`
	ProviderCounts builtInIconProviderCountsResponse              `json:"providerCounts"`
	Providers      map[string]*builtInIconProviderVersionResponse `json:"providers"`
}

var builtInIconIndexRefreshMu sync.Mutex
var builtInIconIndexRefreshingProvider = struct {
	sync.RWMutex
	provider string
}{}
var builtInIconIndexCache = struct {
	sync.RWMutex
	state builtInIconIndexCacheState
}{}
var embeddedBuiltInResolverCache = struct {
	sync.RWMutex
	hash     string
	resolver builtInResolverIndex
	loaded   bool
}{}
var embeddedBuiltInResolverLoadGroup singleflight.Group
var embeddedBuiltInIconSeedMetadata = loadEmbeddedBuiltInIconSeedMetadata()

func init() {
	go func() {
		_, _ = loadEmbeddedBuiltInResolver()
	}()
}

func activeBuiltInResolver(app core.App) builtInResolverIndex {
	record, err := findMediaIconIndexRecord(app)
	if err != nil || !recordHasActiveBuiltInIconIndexes(record) {
		return cachedEmbeddedBuiltInResolver()
	}
	hash := record.GetString("hash")
	builtInIconIndexCache.RLock()
	if builtInIconIndexCache.state.hash == hash {
		resolver := builtInIconIndexCache.state.resolver
		builtInIconIndexCache.RUnlock()
		return resolver
	}
	builtInIconIndexCache.RUnlock()

	searchIndex, err := loadRuntimeBuiltInSearchIndex(record)
	if err != nil {
		return cachedEmbeddedBuiltInResolver()
	}
	states := providerStatesFromRecord(record)
	resolver := buildBuiltInResolverIndexFromSearchIndex(searchIndex, providerCDNBaseOverridesFromStates(states))
	// active 指针按 hash 切换；缓存只保存 resolver，不保存请求级数据，避免用户设置或认证状态串到全局。
	builtInIconIndexCache.Lock()
	builtInIconIndexCache.state = builtInIconIndexCacheState{hash: hash, resolver: resolver}
	builtInIconIndexCache.Unlock()
	return resolver
}

func cachedEmbeddedBuiltInResolver() builtInResolverIndex {
	resolver, err := loadEmbeddedBuiltInResolver()
	if err != nil {
		return builtInResolverIndex{canonicalExact: map[string][]int{}, tokenExact: map[string][]int{}}
	}
	return resolver
}

func loadEmbeddedBuiltInResolver() (builtInResolverIndex, error) {
	hash := embeddedBuiltInIconIndexHash()
	embeddedBuiltInResolverCache.RLock()
	if embeddedBuiltInResolverCache.loaded && embeddedBuiltInResolverCache.hash == hash {
		resolver := embeddedBuiltInResolverCache.resolver
		embeddedBuiltInResolverCache.RUnlock()
		return resolver, nil
	}
	embeddedBuiltInResolverCache.RUnlock()

	value, err, _ := embeddedBuiltInResolverLoadGroup.Do("embedded-search-index", func() (any, error) {
		// seed 搜索索引异步预热且由 singleflight 合并；首个搜索若抢先到达，只会等待同一份 gzip 解析任务。
		searchIndex, err := loadBuiltInIconSearchIndexFromGzip(appstatic.BuiltInIconsSearchIndexGzip)
		if err != nil {
			return builtInResolverIndex{}, err
		}
		resolver := buildBuiltInResolverIndexFromSearchIndex(searchIndex, nil)
		embeddedBuiltInResolverCache.Lock()
		embeddedBuiltInResolverCache.hash = hash
		embeddedBuiltInResolverCache.resolver = resolver
		embeddedBuiltInResolverCache.loaded = true
		embeddedBuiltInResolverCache.Unlock()
		return resolver, nil
	})
	if err != nil {
		return builtInResolverIndex{}, err
	}
	return value.(builtInResolverIndex), nil
}

func handleBuiltInIconIndexStatus(app core.App, e *core.RequestEvent) error {
	return apiSuccessJSON(e, http.StatusOK, builtInIconIndexStatus(app))
}

func handleBuiltInIconIndexProviderCheck(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	provider := e.Request.PathValue("provider")
	if !validBuiltInIconProvider(provider) {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	if err := requireEmptyRequestBody(e.Request); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}

	// check 只探测 GitHub Atom HEAD，不参与索引构建；不能抢同步刷新锁，否则一次上游超时会挡住用户更新。
	ctx, cancel := context.WithTimeout(e.Request.Context(), 30*time.Second)
	defer cancel()
	checkedAt := time.Now().UTC().Format(time.RFC3339Nano)
	version, etag, err := checkLatestBuiltInIconProviderVersion(ctx, app, provider)
	if err != nil {
		saveMediaIconProviderFailure(app, provider, checkedAt, err)
		status := builtInIconIndexStatus(app)
		// check 只更新 provider 可见状态；GitHub 限流/断网时仍返回同形状 body，让前端展示失败 badge 而不是把弹层流程打断。
		return apiSuccessJSON(e, http.StatusOK, builtInIconIndexProviderCheckResponse{Status: status, Provider: providerStatusFromResponse(status, provider), ErrorDetails: upstreamErrorDetailsFromError(err)})
	}
	if err := saveMediaIconProviderLatest(app, provider, checkedAt, version, etag); err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	status := builtInIconIndexStatus(app)
	return apiSuccessJSON(e, http.StatusOK, builtInIconIndexProviderCheckResponse{Status: status, Provider: providerStatusFromResponse(status, provider)})
}

func handleBuiltInIconIndexProviderRefresh(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	provider := e.Request.PathValue("provider")
	if !validBuiltInIconProvider(provider) {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	if err := requireEmptyRequestBody(e.Request); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	// Docker 版仍在请求内构建完整索引，必须用进程内锁防止并发 gzip/落库互相覆盖。
	if !acquireBuiltInIconIndexOperation(provider) {
		return apiErrorJSON(e, http.StatusConflict, "MEDIA_ICON_INDEX_REFRESHING", "Built-in icon index refresh is already running", nil)
	}
	operationActive := true
	defer func() {
		if operationActive {
			releaseBuiltInIconIndexOperation()
		}
	}()

	ctx, cancel := context.WithTimeout(e.Request.Context(), 60*time.Second)
	defer cancel()
	checkedAt := time.Now().UTC().Format(time.RFC3339Nano)
	version, etag, err := checkLatestBuiltInIconProviderVersion(ctx, app, provider)
	if err != nil {
		saveMediaIconProviderFailure(app, provider, checkedAt, err)
		// 失败路径只释放当前同步操作并记录 provider 错误；旧 active 索引继续服务搜索。
		releaseBuiltInIconIndexOperation()
		operationActive = false
		return apiErrorJSON(e, http.StatusBadGateway, "MEDIA_ICON_INDEX_REFRESH_FAILED", "Built-in icon index refresh failed", upstreamErrorDetailsFromError(err))
	}
	if version == nil || version.CommitSHA == nil || *version.CommitSHA == "" {
		err := errors.New("latest provider commit is unavailable")
		saveMediaIconProviderFailure(app, provider, checkedAt, err)
		releaseBuiltInIconIndexOperation()
		operationActive = false
		return apiErrorJSON(e, http.StatusBadGateway, "MEDIA_ICON_INDEX_REFRESH_FAILED", "Built-in icon index refresh failed", upstreamErrorDetailsFromError(err))
	}
	sourceRef := builtInIconProviderSourceRef{
		Provider: provider,
		CDNBase:  mediaResolverBuiltInProviderPinnedBase(provider, *version.CommitSHA),
	}
	providerIcons, err := buildRemoteBuiltInIconProviderIndex(ctx, provider, &sourceRef)
	if err != nil {
		saveMediaIconProviderFailure(app, provider, checkedAt, err)
		releaseBuiltInIconIndexOperation()
		operationActive = false
		return apiErrorJSON(e, http.StatusBadGateway, "MEDIA_ICON_INDEX_REFRESH_FAILED", "Built-in icon index refresh failed", upstreamErrorDetailsFromError(err))
	}
	activeIcons := activeBuiltInIconIndex(app)
	// Docker 存的是合并后的全量索引；刷新单个 provider 时只替换该 provider，其它来源沿用当前 active。
	icons, err := replaceBuiltInIconProviderIndex(activeIcons, provider, providerIcons)
	if err != nil {
		saveMediaIconProviderFailure(app, provider, checkedAt, err)
		releaseBuiltInIconIndexOperation()
		operationActive = false
		return apiErrorJSON(e, http.StatusBadGateway, "MEDIA_ICON_INDEX_REFRESH_FAILED", "Built-in icon index refresh failed", upstreamErrorDetailsFromError(err))
	}
	encoded, err := encodeBuiltInIconIndex(icons)
	if err != nil {
		saveMediaIconProviderFailure(app, provider, checkedAt, err)
		releaseBuiltInIconIndexOperation()
		operationActive = false
		return apiErrorJSON(e, http.StatusBadGateway, "MEDIA_ICON_INDEX_REFRESH_FAILED", "Built-in icon index refresh failed", upstreamErrorDetailsFromError(err))
	}
	if err := saveMediaIconProviderRefreshSuccess(app, provider, checkedAt, encoded, icons, version, etag); err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	releaseBuiltInIconIndexOperation()
	operationActive = false
	status := builtInIconIndexStatus(app)
	job := dockerBuiltInIconRefreshJob(provider, checkedAt, encoded.hash)
	return apiSuccessJSON(e, http.StatusOK, builtInIconIndexProviderRefreshResponse{Status: status, Provider: providerStatusFromResponse(status, provider), Job: job})
}

func builtInIconIndexStatus(app core.App) builtInIconIndexStatusResponse {
	record, err := findMediaIconIndexRecord(app)
	refreshingProvider := currentBuiltInIconIndexRefreshingProvider()
	if err != nil || !recordHasActiveBuiltInIconIndexes(record) {
		status := embeddedBuiltInIconIndexStatus(providerStatesFromRecord(record))
		if record != nil {
			status.CheckedAt = stringPtrOrNil(record.GetString("checkedAt"))
		}
		status.Refreshing = refreshingProvider != ""
		status.Providers = providerStatusesFromState(status.ProviderCounts, providerStatesFromRecord(record), refreshingProvider)
		return status
	}
	states := providerStatesFromRecord(record)
	status := builtInIconIndexStatusResponse{
		Source:         "runtime",
		Hash:           stringPtrOrNil(record.GetString("hash")),
		IconCount:      record.GetInt("iconCount"),
		ProviderCounts: providerCountsResponseFromValue(record.Get("providerCounts")),
		CheckedAt:      stringPtrOrNil(record.GetString("checkedAt")),
		UpdatedAt:      stringPtrOrNil(record.GetString("indexUpdatedAt")),
		Refreshing:     refreshingProvider != "",
	}
	status.Providers = providerStatusesFromState(status.ProviderCounts, states, refreshingProvider)
	return status
}

func embeddedBuiltInIconIndexStatus(states storedBuiltInIconProviderStates) builtInIconIndexStatusResponse {
	hash := embeddedBuiltInIconIndexHash()
	status := builtInIconIndexStatusResponse{
		Source:         "embedded",
		Hash:           &hash,
		IconCount:      embeddedBuiltInIconSeedMetadata.IconCount,
		ProviderCounts: embeddedBuiltInIconSeedMetadata.ProviderCounts,
		CheckedAt:      nil,
		UpdatedAt:      nil,
		Refreshing:     false,
	}
	status.Providers = providerStatusesFromState(status.ProviderCounts, states, "")
	return status
}

func activeBuiltInIconIndex(app core.App) []builtInIcon {
	record, err := findMediaIconIndexRecord(app)
	if err != nil || !recordHasActiveBuiltInIconIndexes(record) {
		return loadEmbeddedBuiltInDetailIcons()
	}
	icons, err := loadRuntimeBuiltInIcons(record)
	if err != nil {
		return loadEmbeddedBuiltInDetailIcons()
	}
	return icons
}

func recordHasActiveBuiltInIconIndexes(record *core.Record) bool {
	return record != nil &&
		record.GetString("hash") != "" &&
		record.GetString("searchIndexGzipBase64") != "" &&
		record.GetString("detailIndexGzipBase64") != ""
}

func findMediaIconIndexRecord(app core.App) (*core.Record, error) {
	record, err := app.FindFirstRecordByFilter("media_icon_indexes", "key = {:key}", dbx.Params{"key": mediaIconIndexRecordKey})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return record, err
}

func mediaIconIndexRecord(app core.App) (*core.Record, error) {
	record, err := findMediaIconIndexRecord(app)
	if err != nil {
		return nil, err
	}
	if record != nil {
		return record, nil
	}
	collection, err := app.FindCollectionByNameOrId("media_icon_indexes")
	if err != nil {
		return nil, err
	}
	record = core.NewRecord(collection)
	record.Set("key", mediaIconIndexRecordKey)
	return record, nil
}

func saveMediaIconProviderLatest(app core.App, provider string, checkedAt string, version *builtInIconProviderVersionResponse, etag string) error {
	record, err := mediaIconIndexRecord(app)
	if err != nil {
		return err
	}
	states := providerStatesFromRecord(record)
	state := states[provider]
	state.Latest = version
	state.CheckedAt = checkedAt
	state.LastError = ""
	if etag != "" {
		state.ETag = etag
	}
	states[provider] = state
	record.Set("checkedAt", checkedAt)
	record.Set("providerStatus", states)
	return app.Save(record)
}

func saveMediaIconProviderRefreshSuccess(app core.App, provider string, checkedAt string, encoded encodedBuiltInIconIndex, icons []builtInIcon, version *builtInIconProviderVersionResponse, etag string) error {
	record, err := mediaIconIndexRecord(app)
	if err != nil {
		return err
	}
	states := providerStatesFromRecord(record)
	state := states[provider]
	state.Current = version
	state.Latest = version
	state.CheckedAt = checkedAt
	state.RefreshedAt = checkedAt
	state.LastError = ""
	if etag != "" {
		state.ETag = etag
	}
	states[provider] = state
	record.Set("hash", encoded.hash)
	record.Set("iconCount", len(icons))
	record.Set("providerCounts", providerCountsMap(icons))
	record.Set("checkedAt", checkedAt)
	record.Set("indexUpdatedAt", checkedAt)
	record.Set("providerStatus", states)
	record.Set("searchIndexGzipBase64", encoded.searchIndexGzipBase64)
	record.Set("detailIndexGzipBase64", encoded.detailIndexGzipBase64)
	if err := app.Save(record); err != nil {
		return err
	}
	// 两份 gzip 都成功落库后才替换 hash cache；失败路径只写 lastError，普通搜索继续使用旧 active。
	resolver := buildBuiltInResolverIndexFromSearchIndex(encoded.searchIndex, providerCDNBaseOverridesFromStates(states))
	builtInIconIndexCache.Lock()
	builtInIconIndexCache.state = builtInIconIndexCacheState{hash: encoded.hash, resolver: resolver}
	builtInIconIndexCache.Unlock()
	return nil
}

func saveMediaIconProviderFailure(app core.App, provider string, checkedAt string, failure error) builtInIconIndexStatusResponse {
	record, err := mediaIconIndexRecord(app)
	if err == nil {
		states := providerStatesFromRecord(record)
		state := states[provider]
		state.CheckedAt = checkedAt
		state.LastError = truncateText(persistentUpstreamErrorMessage(failure), 2000)
		states[provider] = state
		record.Set("checkedAt", checkedAt)
		record.Set("providerStatus", states)
		_ = app.Save(record)
	}
	status := builtInIconIndexStatus(app)
	return status
}

func encodeBuiltInIconIndex(icons []builtInIcon) (encodedBuiltInIconIndex, error) {
	detailRaw, err := json.Marshal(icons)
	if err != nil {
		return encodedBuiltInIconIndex{}, err
	}
	detailRaw = append(detailRaw, '\n')
	searchIndex := createBuiltInIconSearchIndex(icons)
	searchRaw, err := json.Marshal(searchIndex)
	if err != nil {
		return encodedBuiltInIconIndex{}, err
	}
	searchRaw = append(searchRaw, '\n')
	hashBytes := sha256.Sum256(detailRaw)
	searchGzip, err := gzipBytes(searchRaw)
	if err != nil {
		return encodedBuiltInIconIndex{}, err
	}
	detailGzip, err := gzipBytes(detailRaw)
	if err != nil {
		return encodedBuiltInIconIndex{}, err
	}
	return encodedBuiltInIconIndex{
		hash:                  hex.EncodeToString(hashBytes[:]),
		searchIndex:           searchIndex,
		searchIndexGzipBase64: base64.StdEncoding.EncodeToString(searchGzip),
		detailIndexGzipBase64: base64.StdEncoding.EncodeToString(detailGzip),
	}, nil
}

func loadRuntimeBuiltInSearchIndex(record *core.Record) (builtInIconSearchIndex, error) {
	compressed, err := base64.StdEncoding.DecodeString(record.GetString("searchIndexGzipBase64"))
	if err != nil {
		return builtInIconSearchIndex{}, err
	}
	return loadBuiltInIconSearchIndexFromGzip(compressed)
}

func loadRuntimeBuiltInIcons(record *core.Record) ([]builtInIcon, error) {
	compressed, err := base64.StdEncoding.DecodeString(record.GetString("detailIndexGzipBase64"))
	if err != nil {
		return nil, err
	}
	return loadBuiltInIconsFromGzip(compressed)
}

func loadEmbeddedBuiltInDetailIcons() []builtInIcon {
	icons, err := loadBuiltInIconsFromGzip(appstatic.BuiltInIconsDetailIndexGzip)
	if err != nil {
		return []builtInIcon{}
	}
	return icons
}

func loadBuiltInIconSearchIndexFromGzip(compressed []byte) (builtInIconSearchIndex, error) {
	raw, err := gunzipLimited(compressed, 16*1024*1024)
	if err != nil {
		return builtInIconSearchIndex{}, err
	}
	var index builtInIconSearchIndex
	if err := json.Unmarshal(raw, &index); err != nil {
		return builtInIconSearchIndex{}, err
	}
	if index.Version != 1 {
		return builtInIconSearchIndex{}, errors.New("unsupported built-in icon search index version")
	}
	return index, nil
}

func loadBuiltInIconsFromGzip(compressed []byte) ([]builtInIcon, error) {
	raw, err := gunzipLimited(compressed, 16*1024*1024)
	if err != nil {
		return nil, err
	}
	var icons []builtInIcon
	if err := json.Unmarshal(raw, &icons); err != nil {
		return nil, err
	}
	return icons, nil
}

func gzipBytes(raw []byte) ([]byte, error) {
	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	if _, err := gzipWriter.Write(raw); err != nil {
		return nil, err
	}
	if err := gzipWriter.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func gunzipLimited(compressed []byte, limit int64) ([]byte, error) {
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	raw, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, errors.New("built-in icon index is too large")
	}
	return raw, nil
}

func embeddedBuiltInIconIndexHash() string {
	return embeddedBuiltInIconSeedMetadata.Hash
}

func loadEmbeddedBuiltInIconSeedMetadata() builtInIconSeedMetadata {
	var metadata builtInIconSeedMetadata
	if err := json.Unmarshal(appstatic.BuiltInIconsIndexMetadata, &metadata); err != nil {
		return builtInIconSeedMetadata{Providers: map[string]*builtInIconProviderVersionResponse{}}
	}
	if metadata.Providers == nil {
		metadata.Providers = map[string]*builtInIconProviderVersionResponse{}
	}
	return metadata
}

func embeddedProviderVersion(provider string) *builtInIconProviderVersionResponse {
	version := embeddedBuiltInIconSeedMetadata.Providers[provider]
	if version == nil || version.CommitSHA == nil || *version.CommitSHA == "" || version.CommitShortSHA == nil || *version.CommitShortSHA == "" {
		return nil
	}
	// seed metadata 是生成期记录的真实 GitHub HEAD；runtime 缺 provider current 时只能回退到它，不能编造 embedded/runtime 版本。
	return cloneBuiltInIconProviderVersion(version)
}

func cloneBuiltInIconProviderVersion(version *builtInIconProviderVersionResponse) *builtInIconProviderVersionResponse {
	if version == nil {
		return nil
	}
	clone := *version
	clone.CommitSHA = cloneStringPtr(version.CommitSHA)
	clone.CommitShortSHA = cloneStringPtr(version.CommitShortSHA)
	clone.CommitDate = cloneStringPtr(version.CommitDate)
	clone.ReleaseTag = cloneStringPtr(version.ReleaseTag)
	clone.ReleasePublishedAt = cloneStringPtr(version.ReleasePublishedAt)
	return &clone
}

func cloneStringPtr(value *string) *string {
	if value == nil {
		return nil
	}
	clone := *value
	return &clone
}

func providerStatusesFromState(counts builtInIconProviderCountsResponse, states storedBuiltInIconProviderStates, refreshingProvider string) []builtInIconIndexProviderStatusResponse {
	out := make([]builtInIconIndexProviderStatusResponse, 0, len(builtInIconProviders))
	for _, provider := range builtInIconProviders {
		state := states[provider]
		current := state.Current
		if current == nil {
			current = embeddedProviderVersion(provider)
		}
		status := builtInIconIndexProviderStatusResponse{
			Provider:        provider,
			Current:         current,
			Latest:          state.Latest,
			IconCount:       providerCount(counts, provider),
			CheckedAt:       stringPtrOrNil(state.CheckedAt),
			RefreshedAt:     stringPtrOrNil(state.RefreshedAt),
			LastError:       stringPtrOrNil(state.LastError),
			Refreshing:      refreshingProvider == provider,
			UpdateAvailable: providerUpdateAvailable(current, state.Latest),
		}
		out = append(out, status)
	}
	return out
}

func providerStatusFromResponse(status builtInIconIndexStatusResponse, provider string) builtInIconIndexProviderStatusResponse {
	for _, item := range status.Providers {
		if item.Provider == provider {
			return item
		}
	}
	return builtInIconIndexProviderStatusResponse{Provider: provider}
}

func dockerBuiltInIconRefreshJob(provider string, checkedAt string, indexHash string) builtInIconRefreshJobResponse {
	// Docker 后端仍同步构建索引；返回同一 job shape 只作为跨运行面契约，不引入后台队列状态。
	return builtInIconRefreshJobResponse{
		ID:         "docker-" + provider + "-" + strings.NewReplacer(":", "", ".", "", "-", "", "T", "", "Z", "").Replace(checkedAt),
		Provider:   provider,
		Status:     "succeeded",
		QueuedAt:   checkedAt,
		StartedAt:  stringPtrOrNil(checkedAt),
		FinishedAt: stringPtrOrNil(checkedAt),
		Attempts:   1,
		Error:      nil,
		IndexHash:  stringPtrOrNil(indexHash),
	}
}

func providerStatesFromRecord(record *core.Record) storedBuiltInIconProviderStates {
	if record == nil {
		return emptyProviderStates()
	}
	states := parseProviderStates(record.Get("providerStatus"))
	for _, provider := range builtInIconProviders {
		if _, ok := states[provider]; !ok {
			states[provider] = storedBuiltInIconProviderState{}
		}
	}
	return states
}

func parseProviderStates(value any) storedBuiltInIconProviderStates {
	if value == nil {
		return emptyProviderStates()
	}
	raw, err := json.Marshal(value)
	if err != nil || len(raw) > builtInIconProviderStatusMaxBytes {
		return emptyProviderStates()
	}
	var states storedBuiltInIconProviderStates
	if err := json.Unmarshal(raw, &states); err != nil || states == nil {
		return emptyProviderStates()
	}
	return states
}

func emptyProviderStates() storedBuiltInIconProviderStates {
	states := storedBuiltInIconProviderStates{}
	for _, provider := range builtInIconProviders {
		states[provider] = storedBuiltInIconProviderState{}
	}
	return states
}

func providerCDNBaseOverridesFromStates(states storedBuiltInIconProviderStates) map[string]string {
	out := map[string]string{}
	for provider, state := range states {
		if state.Current != nil && state.Current.CommitSHA != nil && *state.Current.CommitSHA != "" {
			out[provider] = mediaResolverBuiltInProviderPinnedBase(provider, *state.Current.CommitSHA)
		}
	}
	return out
}

func acquireBuiltInIconIndexOperation(provider string) bool {
	if !builtInIconIndexRefreshMu.TryLock() {
		return false
	}
	builtInIconIndexRefreshingProvider.Lock()
	builtInIconIndexRefreshingProvider.provider = provider
	builtInIconIndexRefreshingProvider.Unlock()
	return true
}

func releaseBuiltInIconIndexOperation() {
	builtInIconIndexRefreshingProvider.Lock()
	builtInIconIndexRefreshingProvider.provider = ""
	builtInIconIndexRefreshingProvider.Unlock()
	builtInIconIndexRefreshMu.Unlock()
}

func currentBuiltInIconIndexRefreshingProvider() string {
	builtInIconIndexRefreshingProvider.RLock()
	defer builtInIconIndexRefreshingProvider.RUnlock()
	return builtInIconIndexRefreshingProvider.provider
}

func validBuiltInIconProvider(provider string) bool {
	for _, item := range builtInIconProviders {
		if item == provider {
			return true
		}
	}
	return false
}

func providerUpdateAvailable(current *builtInIconProviderVersionResponse, latest *builtInIconProviderVersionResponse) bool {
	if latest == nil {
		return false
	}
	if current == nil {
		return true
	}
	if current.CommitSHA != nil && latest.CommitSHA != nil {
		return *current.CommitSHA != *latest.CommitSHA
	}
	return current.SourceRef != latest.SourceRef
}

func providerCount(counts builtInIconProviderCountsResponse, provider string) int {
	switch provider {
	case "thesvg":
		return counts.TheSVG
	case "selfhst":
		return counts.Selfhst
	case "dashboardIcons":
		return counts.DashboardIcons
	default:
		return 0
	}
}

func providerCountsMap(icons []builtInIcon) map[string]int {
	counts := map[string]int{"thesvg": 0, "selfhst": 0, "dashboardIcons": 0}
	for _, icon := range icons {
		counts[icon.Provider] += 1
	}
	return counts
}

func providerCountsResponseFromMap(counts map[string]int) builtInIconProviderCountsResponse {
	return builtInIconProviderCountsResponse{
		TheSVG:         counts["thesvg"],
		Selfhst:        counts["selfhst"],
		DashboardIcons: counts["dashboardIcons"],
	}
}

func providerCountsResponseFromValue(value any) builtInIconProviderCountsResponse {
	if counts, ok := value.(map[string]any); ok {
		return builtInIconProviderCountsResponse{
			TheSVG:         intFromAny(counts["thesvg"]),
			Selfhst:        intFromAny(counts["selfhst"]),
			DashboardIcons: intFromAny(counts["dashboardIcons"]),
		}
	}
	if counts, ok := value.(map[string]int); ok {
		return providerCountsResponseFromMap(counts)
	}
	raw, err := json.Marshal(value)
	if err == nil {
		counts := map[string]int{}
		if err := json.Unmarshal(raw, &counts); err == nil {
			return providerCountsResponseFromMap(counts)
		}
	}
	return builtInIconProviderCountsResponse{}
}

func intFromAny(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case json.Number:
		n, _ := typed.Int64()
		return int(n)
	default:
		return 0
	}
}

func stringPtrOrNil(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}

func truncateText(value string, maxRunes int) string {
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes])
}
