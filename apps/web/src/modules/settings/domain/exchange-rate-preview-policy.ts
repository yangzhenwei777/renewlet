import type { ConfigItem } from "@/types/config";
import type { ExchangeRates } from "@/lib/api/schemas/exchange-rates";

const EXCHANGE_RATE_PREVIEW_LIMIT = 8;

export function getExchangeRatePreviewCurrencies(
  currencies: readonly ConfigItem[],
  defaultCurrency: string,
  limit = EXCHANGE_RATE_PREVIEW_LIMIT,
): ConfigItem[] {
  const previewCurrencies: ConfigItem[] = [];
  const seen = new Set<string>();
  const normalizedDefaultCurrency = defaultCurrency.trim().toUpperCase();

  for (const currency of currencies) {
    if (previewCurrencies.length >= limit) break;
    const currencyValue = currency.value.trim().toUpperCase();
    if (!currencyValue || seen.has(currencyValue) || currencyValue === normalizedDefaultCurrency) continue;

    seen.add(currencyValue);
    if (currency.enabled === false) continue;

    // 汇率预览是设置页中的货币列表展示，也必须服从货币管理顺序；默认统计货币只作为报价目标跳过。
    previewCurrencies.push(currency);
  }

  return previewCurrencies;
}

export function getDirectExchangeRateQuote(
  rates: ExchangeRates,
  fromCurrency: string,
  toCurrency: string,
): number {
  const fromRate = rates[fromCurrency] || 1;
  const toRate = rates[toCurrency] || 1;

  // 设置页预览按用户消费视角报价：1 个订阅原币折算为多少统计货币，而不是展示汇率源内部的反向基准。
  return toRate / fromRate;
}
