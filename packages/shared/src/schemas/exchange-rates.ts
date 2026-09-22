import { z } from "zod";
import { normalizeExchangeRateProvider } from "../runtime";

/**
 * 汇率 provider 枚举。
 *
 * settings 里只保存 provider key；具体外部 API 响应由前端 service 层转换成统一 USD 基准数据。
 */
export const exchangeRateProviderSchema = z.enum(["frankfurter", "floatrates", "exchange-api"]);

/** 三个汇率来源可互补覆盖的 Renewlet 法币集合；响应校验、前端选项和测试 fixture 必须共用这一事实源。 */
export const SUPPORTED_EXCHANGE_RATE_CURRENCIES = [
  "AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT",
  "BHD", "BIF", "BND", "BOB", "BRL", "BSD", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF",
  "CLP", "CNY", "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP",
  "ERN", "ETB", "EUR", "FJD", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD",
  "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD",
  "JPY", "KES", "KGS", "KHR", "KMF", "KRW", "KWD", "KZT", "LAK", "LBP", "LKR", "LRD",
  "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR",
  "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB",
  "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR",
  "SBD", "SCR", "SDG", "SEK", "SGD", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL",
  "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD",
  "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XCG", "XOF", "XPF", "YER",
  "ZAR", "ZMW",
] as const;
export type SupportedExchangeRateCurrency = (typeof SUPPORTED_EXCHANGE_RATE_CURRENCIES)[number];

export { normalizeExchangeRateProvider };

/** 统一汇率表以 USD 为基准，key 固定为 ISO 4217 三字母大写代码。 */
export const exchangeRatesSchema = z.record(
  z.string().regex(/^[A-Z]{3}$/),
  z.number().finite().positive(),
);

/** currency-api.pages.dev 的 USD 响应允许额外字段；只提取 date 和 usd 汇率表。 */
export const exchangeApiUsdResponseSchema = z.object({
  date: z.string().min(1),
  usd: z.record(z.string(), z.number().finite().positive()),
}).passthrough();

const positiveFiniteNumberFromProviderSchema = z.union([
  z.number().finite().positive(),
  // FloatRates 线上可能把 rate/inverseRate 返回成数字字符串；只接受普通十进制，避免 NaN/Infinity/本地化逗号混入缓存。
  z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).transform((value, context) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected a positive finite number",
      });
      return z.NEVER;
    }
    return parsed;
  }),
]);

/** Frankfurter v2 响应是数组行，不是旧版 rates map；进入缓存前会归一为 USD 大写代码表。 */
export const frankfurterRateRowSchema = z.object({
  date: z.string().min(1),
  base: z.literal("USD"),
  quote: z.string().regex(/^[A-Z]{3}$/),
  rate: z.number().finite().positive(),
}).passthrough();

export const frankfurterRatesResponseSchema = z.array(frankfurterRateRowSchema);

/** FloatRates 响应按小写货币代码分桶，进入缓存前会转换为统一大写代码表。 */
export const floatRatesRateRowSchema = z.object({
  alphaCode: z.string().regex(/^[A-Z]{3}$/),
  rate: positiveFiniteNumberFromProviderSchema,
  inverseRate: positiveFiniteNumberFromProviderSchema.optional(),
  date: z.string().min(1),
}).passthrough();

export const floatRatesResponseSchema = z.record(
  z.string().regex(/^[a-z]{3}$/),
  floatRatesRateRowSchema,
);

export const exchangeRateDataSchema = z.object({
  base: z.literal("USD"),
  date: z.string().min(1),
  rates: exchangeRatesSchema,
}).strict();

export const exchangeRateSourceSchema = z.enum(["frankfurter", "floatrates", "exchange-api", "builtin"]);
export const exchangeRateSnapshotProviderSchema = exchangeRateProviderSchema;

export const exchangeRateReportMonthSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** partial warning 只解释来源缺口；进入缓存的 rates 仍必须是完整 USD number map，统计侧不用感知补齐过程。 */
export const exchangeRateCoverageWarningSchema = z.object({
  kind: z.literal("partial"),
  provider: exchangeRateProviderSchema,
  missingCurrencies: z.array(z.string().regex(/^[A-Z]{3}$/)),
  fillSources: z.record(z.string().regex(/^[A-Z]{3}$/), exchangeRateSourceSchema),
}).strict();

/** v5 缓存记录请求 provider、实际 provider 和 warning，用于解释降级来源与 partial 补齐来源。 */
export const cachedExchangeRateDataSchema = exchangeRateDataSchema.extend({
  cachedAt: z.number().finite(),
  requestedProvider: exchangeRateProviderSchema,
  provider: exchangeRateProviderSchema,
  warning: exchangeRateCoverageWarningSchema.nullable().optional(),
}).strict();

export const exchangeRateSnapshotBodySchema = z.object({
  base: z.literal("USD"),
  rates: exchangeRatesSchema,
  requestedProvider: exchangeRateSnapshotProviderSchema,
  provider: exchangeRateSnapshotProviderSchema,
  sourceDate: z.string().trim().min(1),
  warning: exchangeRateCoverageWarningSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  // 历史报表快照只能保存可信远端 provider 的 USD 基准数据；内置 fallback 只可用于临时展示。
  if (value.rates["USD"] !== 1) {
    context.addIssue({
      code: "custom",
      path: ["rates", "USD"],
      message: "USD self rate must be 1",
    });
  }
});

export const exchangeRateSnapshotV1Schema = exchangeRateSnapshotBodySchema.extend({
  schemaVersion: z.literal(1),
  month: exchangeRateReportMonthSchema,
  capturedAt: z.string().trim().min(1),
}).strict();

export const exchangeRateSnapshotsPayloadSchema = z.object({
  snapshots: z.array(exchangeRateSnapshotV1Schema),
}).strict();
export const exchangeRateSnapshotPayloadSchema = z.object({
  snapshot: exchangeRateSnapshotV1Schema,
}).strict();

export const exchangeRateSnapshotPublicBasisSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("locked"),
    month: exchangeRateReportMonthSchema,
    base: z.literal("USD"),
    rates: exchangeRatesSchema,
    sourceDate: z.string().trim().min(1),
    capturedAt: z.string().trim().min(1),
  }).strict(),
  z.object({
    status: z.literal("live"),
    month: exchangeRateReportMonthSchema,
  }).strict(),
]);

export type ExchangeRateProvider = z.infer<typeof exchangeRateProviderSchema>;
export type ExchangeRateSource = z.infer<typeof exchangeRateSourceSchema>;
export type ExchangeRates = z.infer<typeof exchangeRatesSchema>;
export type ExchangeRateData = z.infer<typeof exchangeRateDataSchema>;
export type ExchangeRateCoverageWarning = z.infer<typeof exchangeRateCoverageWarningSchema>;
export type CachedExchangeRateData = z.infer<typeof cachedExchangeRateDataSchema>;
export type ExchangeRateReportMonth = z.infer<typeof exchangeRateReportMonthSchema>;
export type ExchangeRateSnapshotBody = z.infer<typeof exchangeRateSnapshotBodySchema>;
export type ExchangeRateSnapshotV1 = z.infer<typeof exchangeRateSnapshotV1Schema>;
export type ExchangeRateSnapshotPublicBasis = z.infer<typeof exchangeRateSnapshotPublicBasisSchema>;
