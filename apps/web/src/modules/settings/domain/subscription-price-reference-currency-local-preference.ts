import { currencyRegionHints, type CurrencyRegionHints } from "@renewlet/shared/currency-region-hints";
import { isSupportedExchangeRateCurrency, type SupportedExchangeRateCurrency } from "@/lib/currency-data";

export interface SubscriptionPriceReferenceCurrencyLocalPreference {
  currency: SupportedExchangeRateCurrency;
  reason: "locale-timezone" | "timezone";
}

export interface SubscriptionPriceReferenceCurrencyLocalPreferenceInput {
  languages?: readonly string[] | undefined;
  timeZone?: string | null | undefined;
  hints?: CurrencyRegionHints | undefined;
}

function normalizeSupportedCurrency(value: string | undefined): SupportedExchangeRateCurrency | null {
  const currency = value?.trim().toUpperCase() ?? "";
  return isSupportedExchangeRateCurrency(currency) ? currency : null;
}

function explicitLocaleRegion(language: string): string | null {
  try {
    const locale = new Intl.Locale(language);
    const region = locale.region?.toUpperCase();
    return region && /^[A-Z]{2}$/.test(region) ? region : null;
  } catch {
    const match = language.match(/(?:^|[-_])([A-Za-z]{2})(?:$|[-_])/);
    return match?.[1] ? match[1].toUpperCase() : null;
  }
}

function firstExplicitLocaleCurrency(languages: readonly string[], hints: CurrencyRegionHints): SupportedExchangeRateCurrency | null | "unsupported" {
  for (const language of languages) {
    const region = explicitLocaleRegion(language);
    if (!region) continue;
    const currency = normalizeSupportedCurrency(hints.territoryCurrencies[region]);
    return currency ?? "unsupported";
  }
  return null;
}

function uniqueTimeZoneCurrency(timeZone: string | null | undefined, hints: CurrencyRegionHints): SupportedExchangeRateCurrency | null | "unsupported" {
  if (!timeZone) return null;
  const territories = hints.timeZoneTerritories[timeZone] ?? [];
  if (territories.length === 0) return null;

  const currencies = new Set<SupportedExchangeRateCurrency>();
  for (const territory of territories) {
    const currency = normalizeSupportedCurrency(hints.territoryCurrencies[territory]);
    if (!currency) return "unsupported";
    currencies.add(currency);
  }

  if (currencies.size !== 1) return null;
  return Array.from(currencies)[0] ?? null;
}

export function inferSubscriptionPriceReferenceCurrency({
  languages = [],
  timeZone,
  hints = currencyRegionHints,
}: SubscriptionPriceReferenceCurrencyLocalPreferenceInput = {}): SubscriptionPriceReferenceCurrencyLocalPreference | null {
  // 语言 region 只用于和时区互证；冲突、缺时区、多币种或 unsupported 都不建议，避免旅行/VPN/浏览器语言偏好误填货币。
  const localeCurrency = firstExplicitLocaleCurrency(languages, hints);
  const timeZoneCurrency = uniqueTimeZoneCurrency(timeZone, hints);

  if (localeCurrency === "unsupported" || timeZoneCurrency === "unsupported") return null;
  if (!timeZoneCurrency) return null;
  if (localeCurrency && localeCurrency !== timeZoneCurrency) return null;

  return {
    currency: timeZoneCurrency,
    reason: localeCurrency ? "locale-timezone" : "timezone",
  };
}

export function getLocalSubscriptionPriceReferenceCurrencyPreference(): SubscriptionPriceReferenceCurrencyLocalPreference | null {
  // 这里只读本机语言偏好和 IANA 时区做低侵扰推断；不是浏览器官方推荐，也不能引入 IP/GPS/远端定位或自动写 settings。
  const languages = typeof navigator === "undefined"
    ? []
    : navigator.languages.length > 0
      ? Array.from(navigator.languages)
      : navigator.language
        ? [navigator.language]
        : [];
  const timeZone = typeof Intl === "undefined"
    ? null
    : Intl.DateTimeFormat().resolvedOptions().timeZone;

  return inferSubscriptionPriceReferenceCurrency({ languages, timeZone });
}
