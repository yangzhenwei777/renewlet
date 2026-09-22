/**
 * 主题设置的 localStorage 缓存（用于首屏快速恢复外观，减少“等待网络导致的闪动”）。
 *
 * 说明：
 * - 数据库是“最终真相”（落库后的跨设备一致性）
 * - localStorage 是“首屏缓存”（不依赖网络即可先恢复上次外观）
 *
 * 状态关系：
 * ```
 * 用户即时预览 -> localStorage + pending=1
 * 保存设置成功 -> pending 清除 -> 数据库成为跨设备来源
 * ```
 *
 * 注意： 所有读取函数都必须容错，localStorage 可能不可用或被用户手动写入脏数据。
 */

import {
  DEFAULT_CUSTOM_THEME_COLOR,
  THEME_MODES,
  THEME_VARIANTS,
  type CustomThemeColor,
  type ThemeMode,
  type ThemeVariant,
} from "@/types/theme";

/** 主题风格缓存 key。 */
export const THEME_VARIANT_STORAGE_KEY = "renewlet_theme_variant";
/** 自定义主题色缓存 key。 */
export const CUSTOM_COLOR_STORAGE_KEY = "renewlet_custom_theme_color";
/** @deprecated 旧 Header pending 语义错误，运行时不再读取。 */
export const APPEARANCE_PENDING_STORAGE_KEY = "renewlet_appearance_pending";
/** Settings 外观草稿 pending key，只能由 Settings 页外观控件写入。 */
export const SETTINGS_APPEARANCE_PENDING_STORAGE_KEY = "renewlet_settings_appearance_pending";
/** Settings 外观草稿的明暗模式 key，避免复用 Header 本机主题偏好。 */
export const SETTINGS_THEME_MODE_STORAGE_KEY = "renewlet_settings_theme_mode";

export interface SettingsAppearanceDraft {
  themeMode: ThemeMode | null;
  themeVariant: ThemeVariant | null;
  themeCustomColor: CustomThemeColor | null;
}

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

function readStorageString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存储失败时保留内存态即可；不要因为隐私模式阻断主题切换。
  }
}

function removeStorageItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 清理失败只影响下次首屏防覆盖标记；当前内存草稿仍由 controller 收敛。
  }
}

function parseStorageJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** 判断未知值是否为受支持主题风格。 */
export function isThemeVariant(value: unknown): value is ThemeVariant {
  return typeof value === "string" && (THEME_VARIANTS as readonly string[]).includes(value);
}

/** 判断未知值是否为合法 HSL 自定义主题色。 */
export function isCustomThemeColor(value: unknown): value is CustomThemeColor {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const h = record["h"];
  const s = record["s"];
  const l = record["l"];
  return (
    typeof h === "number" &&
    typeof s === "number" &&
    typeof l === "number" &&
    h >= 0 &&
    h <= 360 &&
    s >= 0 &&
    s <= 100 &&
    l >= 0 &&
    l <= 100
  );
}

/** 读取主题风格（无值或非法则返回 null）。 */
export const readThemeVariantFromStorage: () => ThemeVariant | null = () => {
  const raw: string | null = readStorageString(THEME_VARIANT_STORAGE_KEY);
  if (!raw) return null;
  return isThemeVariant(raw) ? raw : null;
};

/** 读取自定义主题色（无值或非法则回退到默认值）。 */
export const readCustomThemeColorFromStorage: () => CustomThemeColor = () => {
  const raw: string | null = readStorageString(CUSTOM_COLOR_STORAGE_KEY);
  if (!raw) return DEFAULT_CUSTOM_THEME_COLOR;
  const parsed: unknown = parseStorageJson(raw);
  return isCustomThemeColor(parsed) ? parsed : DEFAULT_CUSTOM_THEME_COLOR;
};

/**
 * 读取自定义主题色（无值或非法则返回 null）。
 *
 * 用途：
 * - 当需要“本地优先，但本地未设置时回退到数据库”的逻辑时，用该方法判断本地是否真的有值
 */
export const readCustomThemeColorFromStorageOrNull: () => CustomThemeColor | null = () => {
  const raw: string | null = readStorageString(CUSTOM_COLOR_STORAGE_KEY);
  if (!raw) return null;
  const parsed: unknown = parseStorageJson(raw);
  return isCustomThemeColor(parsed) ? parsed : null;
};

export const readSettingsThemeModeFromStorage: () => ThemeMode | null = () => {
  const raw: string | null = readStorageString(SETTINGS_THEME_MODE_STORAGE_KEY);
  return isThemeMode(raw) ? raw : null;
};

export const readSettingsAppearanceDraftFromStorage: () => SettingsAppearanceDraft = () => ({
  themeMode: readSettingsThemeModeFromStorage(),
  themeVariant: readThemeVariantFromStorage(),
  themeCustomColor: readCustomThemeColorFromStorageOrNull(),
});

/** 写入主题风格缓存（失败则静默忽略）。 */
export const writeThemeVariantToStorage: (variant: ThemeVariant) => void = (variant) => {
  writeStorageString(THEME_VARIANT_STORAGE_KEY, variant);
};

/** 写入自定义主题色缓存（失败则静默忽略）。 */
export const writeCustomThemeColorToStorage: (color: CustomThemeColor) => void = (color) => {
  writeStorageString(CUSTOM_COLOR_STORAGE_KEY, JSON.stringify(color));
};

/** 读取 Settings 外观草稿 pending；旧 Header pending key 已废弃，不能参与判断。 */
export const readAppearancePendingFromStorage: () => boolean = () => {
  return readStorageString(SETTINGS_APPEARANCE_PENDING_STORAGE_KEY) === "1";
};

/**
 * 写入“外观是否有未保存改动”标记。
 *
 * 说明：
 * - 仅 Settings 页外观草稿未保存时标记 pending；Header 本机主题偏好不能写入这里
 * - pending=true：登录后不使用数据库覆盖 Settings 外观预览（避免冲掉未保存改动）
 * - pending=false：登录后以数据库为准（用于跨设备同步已保存的外观）
 */
export const writeAppearancePendingToStorage: (pending: boolean) => void = (pending) => {
  if (pending) {
    writeStorageString(SETTINGS_APPEARANCE_PENDING_STORAGE_KEY, "1");
    return;
  }
  removeStorageItem(SETTINGS_APPEARANCE_PENDING_STORAGE_KEY);
};

export const writeSettingsThemeModeToStorage: (themeMode: ThemeMode) => void = (themeMode) => {
  writeStorageString(SETTINGS_THEME_MODE_STORAGE_KEY, themeMode);
};

export const clearSettingsAppearanceDraftFromStorage: () => void = () => {
  removeStorageItem(SETTINGS_APPEARANCE_PENDING_STORAGE_KEY);
  removeStorageItem(SETTINGS_THEME_MODE_STORAGE_KEY);
};
