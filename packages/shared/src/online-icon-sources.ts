export const ONLINE_ICON_PROVIDERS = ["appStore"] as const;
// 地区列表是跨 Docker/Worker/前端的请求放大契约；新增地区前必须同步限流、缓存 key 和 UI 文案。
export const APP_STORE_STOREFRONTS = ["us", "cn"] as const;

export type OnlineIconProvider = (typeof ONLINE_ICON_PROVIDERS)[number];
export type AppStoreStorefront = (typeof APP_STORE_STOREFRONTS)[number];
export const DEFAULT_APP_STORE_STOREFRONTS = ["us"] as const satisfies readonly AppStoreStorefront[];

/** 在线图标来源只控制手动搜索入口；它们没有内置 SVG 的变体和索引刷新语义。 */
export interface OnlineIconSourceSetting {
  enabled: boolean;
  storefronts: AppStoreStorefront[];
}

export type OnlineIconSourceSettings = Record<OnlineIconProvider, OnlineIconSourceSetting>;
export type OnlineIconSourceSettingsPatch = Partial<Record<OnlineIconProvider, Partial<OnlineIconSourceSetting>>>;
type LooseOnlineIconSourceSettingsPatch = Partial<Record<OnlineIconProvider, {
  enabled?: boolean | undefined;
  storefronts?: readonly AppStoreStorefront[] | undefined;
} | undefined>>;

export const DEFAULT_ONLINE_ICON_SOURCES: OnlineIconSourceSettings = {
  appStore: { enabled: true, storefronts: [...DEFAULT_APP_STORE_STOREFRONTS] },
};

/** App Store storefront 顺序是跨端排序契约；同时勾选时固定 US 优先，避免结果闪动。 */
export function normalizeAppStoreStorefronts(
  storefronts: readonly AppStoreStorefront[] | undefined,
): AppStoreStorefront[] {
  // 空值只服务历史缺字段读取兜底；写入边界必须由 Zod/Go strict decoder 拒绝空数组。
  const selected = new Set(storefronts && storefronts.length > 0 ? storefronts : DEFAULT_APP_STORE_STOREFRONTS);
  return APP_STORE_STOREFRONTS.filter((storefront) => selected.has(storefront));
}

/** 合并设置 patch 时按来源局部覆盖，避免保存 App Store 开关时影响后续在线来源。 */
export function mergeOnlineIconSourceSettings(
  base: OnlineIconSourceSettings = DEFAULT_ONLINE_ICON_SOURCES,
  patch?: OnlineIconSourceSettingsPatch,
): OnlineIconSourceSettings {
  return Object.fromEntries(ONLINE_ICON_PROVIDERS.map((provider) => [
    provider,
    {
      ...base[provider],
      ...patch?.[provider],
      storefronts: normalizeAppStoreStorefronts(patch?.[provider]?.storefronts ?? base[provider].storefronts),
    },
  ])) as OnlineIconSourceSettings;
}

/** 清理未知在线来源和 UI 临时字段，保持 settings JSON 只保存稳定产品契约。 */
export function cleanOnlineIconSourceSettingsPatch(
  patch?: LooseOnlineIconSourceSettingsPatch,
): OnlineIconSourceSettingsPatch | undefined {
  if (!patch) return undefined;
  // 这里用于读取历史设置和合并已校验 patch，不能替代写入 schema；非法空数组必须在 API 边界失败。
  const entries = ONLINE_ICON_PROVIDERS.flatMap((provider) => {
    const value = patch[provider];
    if (!value) return [];
    const cleanValue: Partial<OnlineIconSourceSetting> = {};
    if (value.enabled !== undefined) cleanValue.enabled = value.enabled;
    if (value.storefronts !== undefined) cleanValue.storefronts = normalizeAppStoreStorefronts(value.storefronts);
    return Object.keys(cleanValue).length > 0 ? [[provider, cleanValue] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) as OnlineIconSourceSettingsPatch : undefined;
}
