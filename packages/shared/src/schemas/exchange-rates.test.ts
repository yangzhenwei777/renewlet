import { describe, expect, it } from "vitest";
import {
  exchangeRateSnapshotV1Schema,
  exchangeRateProviderSchema,
  floatRatesResponseSchema,
  frankfurterRatesResponseSchema,
} from "./exchange-rates";

describe("exchange-rate schemas", () => {
  it("accepts Frankfurter as a supported provider", () => {
    expect(exchangeRateProviderSchema.parse("frankfurter")).toBe("frankfurter");
    expect(exchangeRateProviderSchema.parse("floatrates")).toBe("floatrates");
    expect(exchangeRateProviderSchema.parse("exchange-api")).toBe("exchange-api");
  });

  it("parses Frankfurter v2 USD rows", () => {
    const parsed = frankfurterRatesResponseSchema.parse([
      { date: "2026-07-30", base: "USD", quote: "CNY", rate: 6.7636 },
      { date: "2026-07-30", base: "USD", quote: "EUR", rate: 0.87693 },
    ]);

    expect(parsed[0]?.quote).toBe("CNY");
    expect(parsed[0]?.rate).toBe(6.7636);
  });

  it("converts FloatRates numeric strings to numbers", () => {
    const parsed = floatRatesResponseSchema.parse({
      cny: {
        alphaCode: "CNY",
        rate: "6.76054176",
        inverseRate: "0.147916",
        date: "Thu, 30 Jul 2026 07:55:15 GMT",
      },
    });

    expect(parsed["cny"]?.rate).toBe(6.76054176);
    expect(parsed["cny"]?.inverseRate).toBe(0.147916);
  });

  it("rejects unsafe FloatRates numeric strings", () => {
    for (const rate of ["", "0", "-1", "NaN", "Infinity", "1,234", "oops"]) {
      expect(floatRatesResponseSchema.safeParse({
        cny: {
          alphaCode: "CNY",
          rate,
          date: "Thu, 30 Jul 2026 07:55:15 GMT",
        },
      }).success).toBe(false);
    }
  });

  it("accepts locked report exchange-rate snapshots", () => {
    const parsed = exchangeRateSnapshotV1Schema.parse({
      schemaVersion: 1,
      month: "2026-08",
      base: "USD",
      rates: { USD: 1, CNY: 7.12, EUR: 0.91 },
      requestedProvider: "frankfurter",
      provider: "floatrates",
      sourceDate: "2026-08-05",
      capturedAt: "2026-08-06T01:02:03.000Z",
      warning: {
        kind: "partial",
        provider: "floatrates",
        missingCurrencies: ["CNY"],
        fillSources: { CNY: "exchange-api" },
      },
    });

    expect(parsed.month).toBe("2026-08");
    expect(parsed.rates["USD"]).toBe(1);
  });

  it("rejects unsafe report exchange-rate snapshots", () => {
    const base = {
      schemaVersion: 1,
      month: "2026-08",
      base: "USD",
      rates: { USD: 1, CNY: 7.12 },
      requestedProvider: "frankfurter",
      provider: "frankfurter",
      sourceDate: "2026-08-05",
      capturedAt: "2026-08-06T01:02:03.000Z",
    };

    for (const patch of [
      { month: "2026-13" },
      { base: "EUR" },
      { rates: { USD: 0.99, CNY: 7.12 } },
      { rates: { USD: 1, CNY: 0 } },
      { provider: "builtin" },
      { requestedProvider: "builtin" },
    ]) {
      expect(exchangeRateSnapshotV1Schema.safeParse({ ...base, ...patch }).success).toBe(false);
    }
  });
});
