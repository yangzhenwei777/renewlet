package main

// media_candidates.go 提供 Docker/Go 运行面的 Logo/Icon 候选解析 API。
//
// 架构位置：前端、导入预览和 Cloudflare Worker 都以 shared resolver 配置为事实源；
// Go handler 只负责认证、严格请求体、用户设置读取和响应契约收敛，不在请求路径抓取外部 HTML。
import (
	"context"
	"net/http"

	"github.com/pocketbase/pocketbase/core"
)

func mediaCandidates(e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if e.Auth == nil {
		return e.UnauthorizedError(serverText(locale, "auth.loginRequired"), nil)
	}
	// 候选请求可批量携带导入项；严格 decoder 能阻止旧 favicon-search 形状重新混进统一入口。
	body, err := decodeStrictJSON[mediaCandidateResolveRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if retryAfter := checkMediaCandidateRateLimit(e); retryAfter > 0 {
		// Logo 搜索容易被输入联想连续触发；按会话限流可保护服务端 CPU，同时不影响静态内置索引读取。
		setRetryAfter(e, retryAfter)
		return apiErrorJSON(e, http.StatusTooManyRequests, "RATE_LIMITED", serverText(locale, "rateLimit.tooManyRequests"), nil)
	}

	limit := mediaResolverCfg.Limits.DefaultCandidates
	if body.Limit != nil {
		limit = *body.Limit
	}
	limit = clampInt(limit, 1, mediaResolverCfg.Limits.MaxCandidates)
	settings, err := currentUserSettings(e.App, e.Auth)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "notification.settingsInvalid", err), err)
	}
	resolver := activeBuiltInResolver(e.App)
	allowAppStore := len(body.Items) == 1

	items := make([]mediaCandidateResolveItemResponse, 0, len(body.Items))
	for _, item := range body.Items {
		response := resolveMediaCandidateItem(resolver, body.Kind, body.Mode, item, limit, settings.BuiltInIconSources)
		if allowAppStore {
			// Apple Search API 有共享出口限流；App Store 来源只服务单条手动 Logo 搜索，批量导入/批量查询保持离线候选。
			appendAppStoreCandidates(e.Request.Context(), &response, body.Kind, body.Mode, item, limit, settings.OnlineIconSources)
		}
		items = append(items, response)
	}
	setPrivateShortCache(e)
	return apiSuccessJSON(e, http.StatusOK, mediaCandidateResolveResponse{Items: items})
}

func resolveMediaCandidateItem(resolver builtInResolverIndex, kind string, mode string, item mediaCandidateResolveItem, limit int, sources builtInIconSourceSettings) mediaCandidateResolveItemResponse {
	group := mediaCandidateGroup{
		BuiltIn:  []mediaCandidate{},
		AppStore: []mediaCandidate{},
		Favicon:  []mediaCandidate{},
	}
	var autoCandidate *mediaCandidate

	if mode == "auto" {
		// 导入自动分配只接受内置 provider 的高置信命中；favicon/domain 弱候选必须留给用户手动选择。
		if candidate := resolveBuiltInAutoCandidate(resolver, kind, item.Name, sources); candidate != nil && candidate.AutoAssignable {
			group.BuiltIn = append(group.BuiltIn, *candidate)
			group.Best = candidate
			autoCandidate = candidate
		}
		return mediaCandidateResolveItemResponse{ID: item.ID, AutoCandidate: autoCandidate, Candidates: group}
	}

	// 搜索模式为 favicon 预留预算，避免多 provider/variants 把弱备用候选挤出；自动分配仍只返回内置高置信候选。
	builtInSearch := searchBuiltInCandidates(resolver, kind, item.Name, searchBuiltInCandidateLimit(limit), sources)
	group.BuiltIn = builtInSearch.candidates
	remaining := limit - len(group.BuiltIn)
	if remaining > 0 {
		faviconQuery := item.Name
		if builtInSearch.matchedQuery != "" {
			// 内置 provider 的降词命中词是 resolver 对“品牌名”的最佳判断；favicon 备用沿用它，避免长套餐名生成噪声域名。
			faviconQuery = builtInSearch.matchedQuery
		}
		group.Favicon = generateFaviconCandidates(kind, faviconQuery, item.Website, remaining)
	}
	group.Best = bestMediaCandidate(group)
	return mediaCandidateResolveItemResponse{ID: item.ID, AutoCandidate: nil, Candidates: group}
}

func bestMediaCandidate(group mediaCandidateGroup) *mediaCandidate {
	if len(group.BuiltIn) > 0 {
		return &group.BuiltIn[0]
	}
	if len(group.AppStore) > 0 {
		return &group.AppStore[0]
	}
	if len(group.Favicon) > 0 {
		return &group.Favicon[0]
	}
	return nil
}

func searchBuiltInCandidateLimit(limit int) int {
	reserve := minInt(mediaResolverCfg.CandidateGroups.SearchFaviconReserve, maxInt(0, limit-1))
	return maxInt(1, limit-reserve)
}

func appendAppStoreCandidates(ctx context.Context, response *mediaCandidateResolveItemResponse, kind string, mode string, item mediaCandidateResolveItem, limit int, sources onlineIconSourceSettings) {
	if !shouldSearchAppStoreIcons(kind, mode, sources) {
		return
	}
	remaining := limit - len(response.Candidates.BuiltIn)
	if remaining <= 0 {
		return
	}
	query := item.Name
	if len(response.Candidates.BuiltIn) > 0 && response.Candidates.BuiltIn[0].MatchedQuery != "" {
		query = response.Candidates.BuiltIn[0].MatchedQuery
	}
	candidates, err := searchAppStoreIconCandidates(ctx, kind, query, remaining, sources[appStoreOnlineIconSource].Storefronts)
	if err != nil || len(candidates) == 0 {
		// App Store 是增强来源；Apple 超时、限流或返回异常时只降级该分组，不能让手动 Logo 搜索整体失败。
		return
	}
	response.Candidates.AppStore = candidates
	faviconLimit := maxInt(0, limit-len(response.Candidates.BuiltIn)-len(response.Candidates.AppStore))
	if len(response.Candidates.Favicon) > faviconLimit {
		response.Candidates.Favicon = response.Candidates.Favicon[:faviconLimit]
	}
	response.Candidates.Best = bestMediaCandidate(response.Candidates)
}

func shouldSearchAppStoreIcons(kind string, mode string, sources onlineIconSourceSettings) bool {
	// App Store 图标会把手动搜索词发送到 Apple，且结果不是高置信 SVG；导入自动分配和支付方式图标都不走这个在线来源。
	return kind == "logo" && mode == "search" && sources[appStoreOnlineIconSource].Enabled
}
