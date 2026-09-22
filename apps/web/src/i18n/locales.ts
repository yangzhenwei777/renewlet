/**
 * locale 基础规则。
 *
 * 架构位置：支持集合来自 shared 生成物；本模块只拥有浏览器探测、首屏账号缓存和双语持久化 label 读取。
 *
 * 注意：新增语言时必须补齐 Lingui catalog，并用同构夹具锁住浏览器、Go 与 Worker 的匹配规则。
 */
import {
  FALLBACK_LOCALE,
  SUPPORTED_LOCALES,
  isLocale,
  type Locale,
  type LocalePreference,
} from "@renewlet/shared/i18n-config";
import {
  clearAccountLocaleProjection,
  readAccountLocaleProjection,
  writeAccountLocaleProjection,
} from "@/i18n/account-locale-projection";
import { getProductCurrentUserId } from "@/services/product-session";

export { SUPPORTED_LOCALES, isLocale, type Locale, type LocalePreference };

export type LocalizedLabels = Record<Locale, string>;

export const DEFAULT_LOCALE: Locale = FALLBACK_LOCALE;
const CHINESE_LOCALE = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase().startsWith("zh"));

/** 将设备语言标签收敛到界面语言；中文变体归中文，其它非支持语言统一回退英文。 */
export function normalizeLocale(value: unknown): Locale {
  if (isLocale(value)) return value;
  if (typeof value !== "string") return DEFAULT_LOCALE;
  const normalized = value.trim().toLowerCase();
  if (CHINESE_LOCALE && normalized.startsWith("zh")) return CHINESE_LOCALE;
  return DEFAULT_LOCALE;
}

/** 设备推断只读取浏览器第一首选语言，不把 Accept-Language 或账号 settings 混入客户端职责。 */
export function detectBrowserLocale(): Locale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const language = navigator.languages?.[0] || navigator.language;
  return normalizeLocale(language);
}

/** 明确偏好直接覆盖设备；auto 每次解析当前设备，不能复用后台的英文 fallback helper。 */
export function localeForPreference(preference: LocalePreference): Locale {
  return preference === "auto" ? detectBrowserLocale() : preference;
}

/** React 启动语言与同步 bootstrap 保持同一优先级：明确账号缓存优先，其次设备首选语言。 */
export function getInitialLocale(): Locale {
  return readAccountLocaleProjection(getProductCurrentUserId()) ?? detectBrowserLocale();
}

export { clearAccountLocaleProjection, readAccountLocaleProjection, writeAccountLocaleProjection };

export function labels(zhCN: string, enUS: string): LocalizedLabels {
  return { "zh-CN": zhCN, "en-US": enUS };
}

export function localizedLabel(source: LocalizedLabels, locale: Locale): string {
  const value = source[locale];
  if (!value) {
    throw new Error(`Missing localized label for ${locale}`);
  }
  return value;
}
