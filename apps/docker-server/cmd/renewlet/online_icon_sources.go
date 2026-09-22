package main

const (
	appStoreOnlineIconSource = "appStore"
	appStoreStorefrontUS     = "us"
	appStoreStorefrontCN     = "cn"
)

var (
	// 顺序和 shared APP_STORE_STOREFRONTS 保持一致；它同时影响请求顺序、缓存粒度和双区结果 tie-break。
	appStoreSupportedStorefronts = []string{appStoreStorefrontUS, appStoreStorefrontCN}
	appStoreDefaultStorefronts   = []string{appStoreStorefrontUS}
)

type onlineIconSourceSetting struct {
	Enabled     bool     `json:"enabled"`
	Storefronts []string `json:"storefronts"`
}

type onlineIconSourceSettings map[string]onlineIconSourceSetting

type onlineIconSourceSettingPatch struct {
	Enabled     *bool     `json:"enabled"`
	Storefronts *[]string `json:"storefronts"`
}

func defaultOnlineIconSourceSettings() onlineIconSourceSettings {
	return onlineIconSourceSettings{
		appStoreOnlineIconSource: {Enabled: true, Storefronts: cloneStringSlice(appStoreDefaultStorefronts)},
	}
}

// storefronts 是 Apple 请求放大开关；只允许固定小集合，空列表不能被当成“关闭来源”的隐式语义。
func normalizeAppStoreStorefronts(storefronts []string) ([]string, bool) {
	if len(storefronts) == 0 {
		return nil, false
	}
	selected := map[string]struct{}{}
	for _, storefront := range storefronts {
		if storefront != appStoreStorefrontUS && storefront != appStoreStorefrontCN {
			return nil, false
		}
		if _, ok := selected[storefront]; ok {
			return nil, false
		}
		selected[storefront] = struct{}{}
	}
	out := make([]string, 0, len(selected))
	for _, storefront := range appStoreSupportedStorefronts {
		if _, ok := selected[storefront]; ok {
			out = append(out, storefront)
		}
	}
	return out, true
}

func appStoreStorefrontsOrDefault(storefronts []string) []string {
	if normalized, ok := normalizeAppStoreStorefronts(storefronts); ok {
		return normalized
	}
	// 兜底只用于旧 settings 缺字段或测试空值；正式写入空数组会在 patch decoder 直接失败。
	return cloneStringSlice(appStoreDefaultStorefronts)
}

func cloneStringSlice(value []string) []string {
	return append([]string(nil), value...)
}
