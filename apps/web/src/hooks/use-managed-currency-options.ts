import { useMemo } from "react";
import { createCurrencySelectOptions, type SearchableSelectOption } from "@/lib/searchable-options";
import type { Locale } from "@/i18n/locales";
import type { ConfigItem } from "@/types/config";
import { CURRENCY_OPTIONS } from "@/types/subscription";

/** 全站真实货币候选入口；设置页特殊 sentinel 只能由宿主 prepend，不能混进这里改变货币管理顺序。 */
export function useManagedCurrencyOptions({
  currencies,
  includeDisabledCurrent,
  locale,
}: {
  currencies: readonly ConfigItem[];
  includeDisabledCurrent?: string | null;
  locale: Locale;
}): SearchableSelectOption[] {
  return useMemo(
    () => createCurrencySelectOptions({
      currencies,
      // CURRENCY_OPTIONS 只提供支持范围、Intl label 和搜索关键词；展示顺序必须来自货币管理的持久数组。
      currencyOptions: CURRENCY_OPTIONS,
      ...(includeDisabledCurrent ? { includeDisabledCurrent } : {}),
      locale,
    }),
    [currencies, includeDisabledCurrent, locale],
  );
}
