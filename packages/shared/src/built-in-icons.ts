export const BUILT_IN_ICON_PROVIDERS = ["thesvg", "selfhst", "dashboardIcons"] as const;

export type BuiltInIconProvider = (typeof BUILT_IN_ICON_PROVIDERS)[number];

/** 单个内置图标来源的用户设置；variantsEnabled 控制同 provider 的多变体展开。 */
export interface BuiltInIconSourceSetting {
  enabled: boolean;
  variantsEnabled: boolean;
}

export type BuiltInIconSourceSettings = Record<BuiltInIconProvider, BuiltInIconSourceSetting>;
export type BuiltInIconSourceSettingsPatch = Partial<Record<BuiltInIconProvider, Partial<BuiltInIconSourceSetting>>>;
type LooseBuiltInIconSourceSettingsPatch = Partial<Record<BuiltInIconProvider, {
  enabled?: boolean | undefined;
  variantsEnabled?: boolean | undefined;
} | undefined>>;

export const DEFAULT_BUILT_IN_ICON_SOURCES: BuiltInIconSourceSettings = {
  thesvg: { enabled: true, variantsEnabled: true },
  selfhst: { enabled: true, variantsEnabled: true },
  dashboardIcons: { enabled: true, variantsEnabled: true },
};

/** 至少保留一个 provider 可用，避免 Logo/Icon 候选搜索只剩 favicon 弱备用。 */
export function hasEnabledBuiltInIconSource(settings: BuiltInIconSourceSettings): boolean {
  return BUILT_IN_ICON_PROVIDERS.some((provider) => settings[provider].enabled);
}

/** 合并设置 patch 时只按 provider 局部覆盖，避免保存一个来源时重置其它来源开关。 */
export function mergeBuiltInIconSourceSettings(
  base: BuiltInIconSourceSettings = DEFAULT_BUILT_IN_ICON_SOURCES,
  patch?: BuiltInIconSourceSettingsPatch,
): BuiltInIconSourceSettings {
  return Object.fromEntries(BUILT_IN_ICON_PROVIDERS.map((provider) => [
    provider,
    {
      ...base[provider],
      ...patch?.[provider],
    },
  ])) as BuiltInIconSourceSettings;
}

/** 清理未知 provider/字段，保证 settings PATCH 不把 UI 临时字段带进持久化 JSON。 */
export function cleanBuiltInIconSourceSettingsPatch(
  patch?: LooseBuiltInIconSourceSettingsPatch,
): BuiltInIconSourceSettingsPatch | undefined {
  if (!patch) return undefined;
  const entries = BUILT_IN_ICON_PROVIDERS.flatMap((provider) => {
    const value = patch[provider];
    if (!value) return [];
    const cleanValue: Partial<BuiltInIconSourceSetting> = {};
    if (value.enabled !== undefined) cleanValue.enabled = value.enabled;
    if (value.variantsEnabled !== undefined) cleanValue.variantsEnabled = value.variantsEnabled;
    return Object.keys(cleanValue).length > 0 ? [[provider, cleanValue] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) as BuiltInIconSourceSettingsPatch : undefined;
}
