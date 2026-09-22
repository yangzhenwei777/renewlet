import { describe, expect, it } from "vitest";
import type { ConfigItem } from "@/types/config";
import {
  getDirectExchangeRateQuote,
  getExchangeRatePreviewCurrencies,
} from "./exchange-rate-preview-policy";

const currency = (value: string, enabled = true): ConfigItem => ({
  id: value,
  value,
  labels: {
    "zh-CN": value,
    "en-US": value,
  },
  enabled,
});

const values = (items: readonly ConfigItem[]) => items.map((item) => item.value);

describe("getExchangeRatePreviewCurrencies", () => {
  it("uses the currency manager order and skips the reporting currency", () => {
    const currencies = [
      currency("PHP"),
      currency("CNY"),
      currency("USD"),
      currency("EUR"),
      currency("AED"),
      currency("GBP"),
    ];

    expect(values(getExchangeRatePreviewCurrencies(currencies, "CNY"))).toEqual([
      "PHP", "USD", "EUR", "AED", "GBP",
    ]);
  });

  it("does not force CNY or common currencies ahead when another reporting currency is selected", () => {
    const currencies = [
      currency("USD"),
      currency("PHP"),
      currency("CNY"),
      currency("EUR"),
    ];

    expect(values(getExchangeRatePreviewCurrencies(currencies, "USD"))).toEqual([
      "PHP", "CNY", "EUR",
    ]);
  });

  it("skips disabled and duplicate currencies while respecting the preview limit", () => {
    const currencies = [
      currency("CNY"),
      currency("PHP"),
      currency("AED", false),
      currency("USD"),
      currency("USD"),
      currency("EUR"),
      currency("GBP"),
    ];

    expect(values(getExchangeRatePreviewCurrencies(currencies, "CNY", 3))).toEqual([
      "PHP", "USD", "EUR",
    ]);
  });

  it("returns an empty preview when all managed candidates are unavailable", () => {
    const currencies = [
      currency("CNY"),
      currency("USD", false),
    ];

    expect(getExchangeRatePreviewCurrencies(currencies, "CNY")).toEqual([]);
  });
});

describe("getDirectExchangeRateQuote", () => {
  it("quotes one foreign currency unit in the reporting currency", () => {
    expect(getDirectExchangeRateQuote({ USD: 1, CNY: 6.78 }, "USD", "CNY")).toBeCloseTo(6.78);
    expect(getDirectExchangeRateQuote({ USD: 1, CNY: 6.78 }, "CNY", "USD")).toBeCloseTo(0.1475, 4);
  });

  it("supports reporting currencies other than CNY", () => {
    expect(getDirectExchangeRateQuote({ USD: 1, EUR: 0.92 }, "EUR", "USD")).toBeCloseTo(1.087, 3);
  });

  it("falls back to 1 for missing rates without producing invalid numbers", () => {
    expect(getDirectExchangeRateQuote({ CNY: 6.78 }, "USD", "CNY")).toBe(6.78);
    expect(Number.isFinite(getDirectExchangeRateQuote({}, "USD", "CNY"))).toBe(true);
  });
});
