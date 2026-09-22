import { resolveLocalePreference, type LocalePreference } from "@renewlet/shared/i18n-config";
import {
  DEFAULT_SERVER_I18N_LOCALE,
  SERVER_I18N_CATALOGS,
  SERVER_I18N_LOCALES,
  type ServerI18nCatalog,
  type ServerI18nKey,
  type ServerI18nLocale,
} from "./server-i18n-catalog";

export type AppLocale = ServerI18nLocale;
export { DEFAULT_SERVER_I18N_LOCALE };

// Worker 服务端文案使用生成 catalog，不复用浏览器 Lingui runtime；前端只消费稳定错误 code。

const localeLookup = new Map<string, AppLocale>();
const acceptLanguageQPattern = /^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/;
for (const locale of SERVER_I18N_LOCALES) {
  const normalized = normalizeLocaleTag(locale);
  localeLookup.set(normalized, locale);
  const language = normalized.split("-")[0] ?? normalized;
  if (!localeLookup.has(language)) localeLookup.set(language, locale);
}

function normalizeLocaleTag(value: string): string {
  const normalized = value.trim().replaceAll("_", "-");
  if (!normalized) return "";
  try {
    return (Intl.getCanonicalLocales(normalized)[0] ?? "").toLowerCase();
  } catch {
    return "";
  }
}

function acceptLanguageQuality(value: string | undefined): number {
  if (value === undefined) return 1;
  const normalized = value.trim();
  return acceptLanguageQPattern.test(normalized) ? Number(normalized) : Number.NaN;
}

// 合法完整标签先精确匹配，再按基础语言收敛；结果必须与 Go matchAppLocale 保持同构。
function matchServerLocale(value: string | null | undefined): AppLocale | null {
  const normalized = normalizeLocaleTag(value ?? "");
  if (!normalized) return null;
  const direct = localeLookup.get(normalized);
  if (direct) return direct;
  const language = normalized.split("-")[0] ?? normalized;
  return localeLookup.get(language) ?? null;
}

export function normalizeServerLocale(value: string | null | undefined): AppLocale {
  return matchServerLocale(value) ?? DEFAULT_SERVER_I18N_LOCALE;
}

/** 请求语言与账号内容语言互不覆盖；auto 在 Cron、Feed、Bot 等无设备上下文中稳定回退英文。 */
export function accountContentLocale(preference: LocalePreference): AppLocale {
  return resolveLocalePreference(preference);
}

/** requestLocale 优先读取前端随用户设置发送的显式 locale header。 */
export function requestLocale(request: Request): AppLocale {
  const explicit = request.headers.get("x-renewlet-locale");
  if (explicit?.trim()) {
    // 显式 header 来自用户设置，比浏览器语言更可信；非法值只回默认语言，不再被 Accept-Language 反向覆盖。
    const value = explicit.trim();
    return (SERVER_I18N_LOCALES as readonly string[]).includes(value)
      ? value as AppLocale
      : DEFAULT_SERVER_I18N_LOCALE;
  }
  // Accept-Language 只是无显式设置时的兜底；q 权重、非法项和通配符规则必须与 Go matcher 同构。
  const accepted = (request.headers.get("accept-language") ?? "")
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const qValue = params.map((item) => item.trim()).find((item) => item.slice(0, 2).toLowerCase() === "q=")?.slice(2);
      return { tag: tag.trim(), q: acceptLanguageQuality(qValue), index };
    })
    .filter((item) => item.tag && Number.isFinite(item.q) && item.q > 0 && item.q <= 1)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of accepted) {
    if (tag === "*") return DEFAULT_SERVER_I18N_LOCALE;
    const matched = matchServerLocale(tag);
    if (matched) return matched;
  }
  return DEFAULT_SERVER_I18N_LOCALE;
}

/** serverText 返回服务端 catalog 文案；缺 key 时回 key，便于测试发现 catalog 漂移。 */
export function serverText(locale: AppLocale, key: ServerI18nKey): string {
  const catalogs = SERVER_I18N_CATALOGS as Record<AppLocale, ServerI18nCatalog>;
  return catalogs[locale]?.[key] ?? catalogs[DEFAULT_SERVER_I18N_LOCALE][key] ?? key;
}

/** serverFormat 只做服务端错误/通知所需的命名占位替换，不引入前端 i18n runtime。 */
export function serverFormat(locale: AppLocale, key: ServerI18nKey, params: Record<string, string | number>): string {
  return serverText(locale, key).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
