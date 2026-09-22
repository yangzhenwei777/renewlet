import { z } from "zod";
import currencyRegionHintsJson from "../data/currency-region-hints.json";

export const currencyRegionHintsSchema = z.object({
  sourceVersion: z.object({
    ianaTimeZone: z.string().min(1),
    unicodeCldr: z.string().min(1),
    generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).strict(),
  timeZoneTerritories: z.record(
    z.string().min(1),
    z.array(z.string().regex(/^[A-Z]{2}$/)),
  ),
  territoryCurrencies: z.record(
    z.string().regex(/^[A-Z]{2}$/),
    z.string().regex(/^[A-Z]{3}$/),
  ),
}).strict();

export type CurrencyRegionHints = z.infer<typeof currencyRegionHintsSchema>;

// 语言与时区只能生成本地建议，不能替代用户选择，也不能被当作定位结果持久化。
export const currencyRegionHints: CurrencyRegionHints = currencyRegionHintsSchema.parse(currencyRegionHintsJson);
