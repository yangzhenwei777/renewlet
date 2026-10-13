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

/**
 * 持久化配置 labels 的固定语言集合；它是 custom-config 存储契约，不随界面语言扩展。
 * 其它界面语言显示时回退到内置 catalog 译文或英文 label。
 */
export const LABEL_LOCALES = ["zh-CN", "en-US"] as const satisfies readonly Locale[];
export type LabelLocale = (typeof LABEL_LOCALES)[number];
export type LocalizedLabels = Record<LabelLocale, string>;

export const DEFAULT_LOCALE: Locale = FALLBACK_LOCALE;

function primaryLanguage(tag: string): string {
  return tag.toLowerCase().split(/[-_]/)[0] ?? "";
}

/** 将设备语言标签收敛到界面语言；先精确匹配，再按基础语言匹配（中文变体归中文），其它回退英文。 */
export function normalizeLocale(value: unknown): Locale {
  if (isLocale(value)) return value;
  if (typeof value !== "string") return DEFAULT_LOCALE;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return DEFAULT_LOCALE;
  const exact = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === normalized);
  if (exact) return exact;
  const language = primaryLanguage(normalized);
  return SUPPORTED_LOCALES.find((locale) => primaryLanguage(locale) === language) ?? DEFAULT_LOCALE;
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

export function isLabelLocale(locale: Locale): locale is LabelLocale {
  return (LABEL_LOCALES as readonly string[]).includes(locale);
}

export type DerivedLabelKey = string;

type DerivedLabelDefinition = {
  expected: LocalizedLabels;
  resolve: (locale: Locale) => string;
};

const derivedLabelDefinitions = new Map<DerivedLabelKey, DerivedLabelDefinition>();
const derivedLabelKeys = new WeakMap<LocalizedLabels, DerivedLabelKey>();

/**
 * 为可由运行时推导的 labels 登记稳定来源 key；来源 key 不进入持久化 JSON，显示时还会核对
 * 中英文是否仍等于登记时的官方原值，避免用户自定义文本通过显示文本碰撞命中内置翻译。
 */
export function withDerivedLabels(
  source: LocalizedLabels,
  key: DerivedLabelKey,
  resolve: (locale: Locale) => string,
): LocalizedLabels {
  derivedLabelKeys.set(source, key);
  derivedLabelDefinitions.set(key, { expected: { ...source }, resolve });
  return source;
}

export function localizedLabel(source: LocalizedLabels, locale: Locale, explicitKey?: DerivedLabelKey): string {
  const key = explicitKey ?? derivedLabelKeys.get(source);
  const definition = key ? derivedLabelDefinitions.get(key) : undefined;
  let value: string;
  if (isLabelLocale(locale)) {
    value = source[locale];
  } else if (definition
    && source["zh-CN"] === definition.expected["zh-CN"]
    && source["en-US"] === definition.expected["en-US"]) {
    value = definition.resolve(locale);
  } else {
    value = source["en-US"];
  }
  if (!value) {
    throw new Error(`Missing localized label for ${locale}`);
  }
  return value;
}
