import { useCallback, useEffect, useRef, useState } from "react";
import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import { getIntlCurrencyNarrowSymbol, getIntlCurrencySymbol } from "@/lib/currency-data";
import type {
  ExchangeRateCoverageWarning,
  ExchangeRateProvider,
  ExchangeRates,
  ExchangeRateSource,
} from "@/lib/api/schemas/exchange-rates";
import { formatNumberMaxFractionDigits } from "@/lib/number-format";
import type { RawErrorResponseDetails } from "@/lib/raw-error-response";
import { moneyToNumber } from "@renewlet/shared/money";
import {
  DEFAULT_EXCHANGE_RATE_PROVIDER,
  FALLBACK_RATES,
  defaultExchangeRateStore,
  errorKindFromProviderError,
  exchangeRateErrorDetailsFromError,
  getExchangeRateErrorMessageKey,
  reportExchangeRateFetchError,
  type ExchangeRateSnapshot,
  type ExchangeRateStore,
} from "./exchange-rate-store";

export type ExchangeRateRefreshResult =
  | { status: "succeeded"; warning: ExchangeRateCoverageWarning | null }
  | { status: "failed"; error: string; errorDetails: RawErrorResponseDetails | null }
  | { status: "superseded" };

/**
 * 汇率 Hook（Frankfurter / FloatRates / exchange-api）。
 *
 * 统计页和首页会把所有币种先换算到用户默认货币；修改 base 逻辑会影响全站金额口径。
 * 共享缓存与 provider fallback 由 exchange-rate-store 维护，Hook 只处理 React 生命周期和旧响应防回写。
 */
export function createUseExchangeRates(store: ExchangeRateStore) {
  return function useExchangeRates(preferredProvider: ExchangeRateProvider = DEFAULT_EXCHANGE_RATE_PROVIDER) {
    const [rates, setRates] = useState<ExchangeRates>(FALLBACK_RATES);
    const [baseRate, setBaseRate] = useState<string>("USD");
    const [activeProvider, setActiveProvider] = useState<ExchangeRateSource>("builtin");
    const [loading, setLoading] = useState(true);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [errorDetails, setErrorDetails] = useState<RawErrorResponseDetails | null>(null);
    const [warning, setWarning] = useState<ExchangeRateCoverageWarning | null>(null);
    const [sourceDate, setSourceDate] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const mountedRef = useRef(false);
    const requestSeqRef = useRef(0);

    const applySnapshot = useCallback((snapshot: {
      rates: ExchangeRates;
      baseRate: string;
      activeProvider: ExchangeRateSource;
      warning: ExchangeRateCoverageWarning | null;
      sourceDate: string;
      lastUpdated: Date;
    }) => {
      setRates(snapshot.rates);
      setBaseRate(snapshot.baseRate);
      setActiveProvider(snapshot.activeProvider);
      setWarning(snapshot.warning);
      setSourceDate(snapshot.sourceDate);
      setLastUpdated(snapshot.lastUpdated);
    }, []);

    const fetchRates = useCallback(async (
      forceRefresh = false,
      providerOverride?: ExchangeRateProvider,
    ): Promise<ExchangeRateRefreshResult> => {
      const requestedProvider = providerOverride ?? preferredProvider;
      const requestSeq = requestSeqRef.current + 1;
      requestSeqRef.current = requestSeq;

      if (forceRefresh) {
        setIsRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      setErrorDetails(null);
      // warning 是 partial 成功态，不是错误态；新请求开始时先清空，避免旧缺币提示跟新 provider 混在一起。
      setWarning(null);

      try {
        if (!forceRefresh) {
          const cached = store.readCachedSnapshot(requestedProvider);
          if (cached) {
            applySnapshot(cached);
            return { status: "succeeded", warning: cached.warning };
          }
        }

        const snapshot: ExchangeRateSnapshot = await store.loadRemoteSnapshot(requestedProvider);
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) return { status: "superseded" };
        applySnapshot(snapshot);
        setError(null);
        setErrorDetails(null);
        // partial 成功只透出 warning；只有 catch 路径才上报错误并切到内置备用汇率。
        setWarning(snapshot.warning);
        return { status: "succeeded", warning: snapshot.warning };
      } catch (e) {
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) return { status: "superseded" };
        reportExchangeRateFetchError(e);
        const kind = errorKindFromProviderError(e);
        const nextError = translate(
          getApiLocale(),
          getExchangeRateErrorMessageKey(kind),
        );
        const nextErrorDetails = exchangeRateErrorDetailsFromError(e);
        setError(nextError);
        setErrorDetails(nextErrorDetails);
        // 汇率失败不能拖垮仪表盘；内置快照牺牲实时性，保留跨币种统计的可解释性。
        setRates(FALLBACK_RATES);
        setBaseRate("USD");
        setActiveProvider("builtin");
        setWarning(null);
        setSourceDate(null);
        return { status: "failed", error: nextError, errorDetails: nextErrorDetails };
      } finally {
        if (mountedRef.current && requestSeqRef.current === requestSeq) {
          setLoading(false);
          setIsRefreshing(false);
        }
      }
    }, [applySnapshot, preferredProvider]);

    const refresh = useCallback(
      (providerOverride?: ExchangeRateProvider) => fetchRates(true, providerOverride),
      [fetchRates],
    );

    useEffect(() => {
      mountedRef.current = true;
      const timeoutId = setTimeout(() => {
        void fetchRates();
      }, 0);
      return () => {
        mountedRef.current = false;
        clearTimeout(timeoutId);
        requestSeqRef.current += 1;
      };
    }, [fetchRates]);

    const convert = useCallback((
      amount: number | string,
      fromCurrency: string,
      toCurrency: string,
    ): number => {
      const numericAmount = moneyToNumber(amount);
      if (fromCurrency === toCurrency) return numericAmount;

      const fromRate = rates[fromCurrency] || 1;
      const toRate = rates[toCurrency] || 1;

      // 远端数据统一归一为 USD base；先转 base 再转目标币种，避免维护 N*N 汇率表。
      const amountInBase = numericAmount / fromRate;
      return amountInBase * toRate;
    }, [rates]);

    const getCurrencySymbol = useCallback((currency: string): string => {
      return getIntlCurrencySymbol(currency);
    }, []);

    const formatAmount = useCallback((
      amount: number,
      currency: string,
      maxFractionDigits = 3,
    ): string => {
      const currencyCode = currency.trim().toUpperCase() || currency;
      const symbol = getIntlCurrencyNarrowSymbol(currencyCode);
      const formattedAmount = formatNumberMaxFractionDigits(amount, maxFractionDigits);
      if (!symbol || symbol.trim().toUpperCase() === currencyCode) return `${formattedAmount} ${currencyCode}`;
      return `${symbol}${formattedAmount} ${currencyCode}`;
    }, []);

    return {
      rates,
      baseRate,
      activeProvider,
      loading,
      isRefreshing,
      error,
      errorDetails,
      warning,
      sourceDate,
      lastUpdated,
      convert,
      getCurrencySymbol,
      formatAmount,
      refresh,
    };
  };
}

export const useExchangeRates = createUseExchangeRates(defaultExchangeRateStore);
