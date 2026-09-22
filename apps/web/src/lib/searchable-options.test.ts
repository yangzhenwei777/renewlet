// searchable-options 测试保护货币/标签搜索的宽松匹配口径，避免下拉搜索在中英文输入下退化。
import { describe, expect, it } from "vitest";
import { CURRENCY_OPTIONS } from "@/types/subscription";
import type { ConfigItem } from "@/types/config";
import { getIntlCurrencyOptionLabel } from "@/lib/currency-data";
import {
  createCurrencySelectOptions,
  createCurrencyKeywords,
  createTimeZoneKeywords,
  rankSearchText,
} from "./searchable-options";

function getCurrencyKeywords(value: string): string[] {
  const option = CURRENCY_OPTIONS.find((item) => item.value === value);
  expect(option).toBeDefined();
  return createCurrencyKeywords(option!);
}

function currencyConfig(value: string, enabled = true): ConfigItem {
  return {
    id: value,
    value,
    labels: {
      "zh-CN": value,
      "en-US": value,
    },
    enabled,
  };
}

describe("searchable option keywords", () => {
  it("formats currency identity labels with a single leading symbol or code", () => {
    expect(getIntlCurrencyOptionLabel("CNY", "zh-CN")).toBe("¥ 人民币 (CNY)");
    expect(getIntlCurrencyOptionLabel("USD", "zh-CN")).toBe("$ 美元 (USD)");
    expect(getIntlCurrencyOptionLabel("EUR", "zh-CN")).toBe("€ 欧元 (EUR)");
    expect(getIntlCurrencyOptionLabel("GBP", "zh-CN")).toBe("£ 英镑 (GBP)");
    expect(getIntlCurrencyOptionLabel("AUD", "zh-CN")).toBe("AU$ 澳大利亚元 (AUD)");
    expect(getIntlCurrencyOptionLabel("TRY", "zh-CN")).toBe("₺ 土耳其里拉 (TRY)");
    expect(getIntlCurrencyOptionLabel("NGN", "zh-CN")).toBe("₦ 尼日利亚奈拉 (NGN)");
    expect(getIntlCurrencyOptionLabel("ARS", "zh-CN")).toBe("ARS 阿根廷比索");
  });

  it("matches currencies by code, Chinese label, symbol and English display name", () => {
    const usd = CURRENCY_OPTIONS.find((option) => option.value === "USD");
    expect(usd).toBeDefined();

    const keywords = createCurrencyKeywords(usd!);
    expect(rankSearchText(keywords, "usd")).toBeGreaterThan(0);
    expect(rankSearchText(keywords, "美元")).toBeGreaterThan(0);
    expect(rankSearchText(keywords, "$")).toBeGreaterThan(0);
    expect(rankSearchText(keywords, "US Dollar")).toBeGreaterThan(0);
    expect(rankSearchText(keywords, "$ 美元 (USD)")).toBeGreaterThan(0);
  });

  it("keeps single-character currency searches on high-signal prefixes only", () => {
    for (const value of ["USD", "UAH", "UGX", "UYU", "UZS"]) {
      expect(rankSearchText(getCurrencyKeywords(value), "u")).toBeGreaterThan(0);
    }

    for (const value of ["AUD", "GBP", "TRY", "NGN", "PHP", "AFN", "ALL"]) {
      expect(rankSearchText(getCurrencyKeywords(value), "u")).toBe(0);
    }
  });

  it("does not let generic currency aliases match short searches", () => {
    const usdKeywords = getCurrencyKeywords("USD");

    expect(usdKeywords).not.toEqual(expect.arrayContaining(["全球", "global", "currency"]));
    expect(rankSearchText(["全球", "global", "currency"], "u")).toBe(0);
  });

  it("keeps two-character contains search available for config labels", () => {
    expect(rankSearchText(["ERN Eritrean Nakfa"], "re")).toBeGreaterThan(0);
    expect(rankSearchText(["KRW South Korean Won"], "re")).toBeGreaterThan(0);
  });

  it("does not match short currency code queries as loose subsequences", () => {
    expect(rankSearchText(getCurrencyKeywords("NGN"), "ngn")).toBeGreaterThan(0);
    expect(rankSearchText(getCurrencyKeywords("HKD"), "ngn")).toBe(0);
    expect(rankSearchText(getCurrencyKeywords("AFN"), "ngn")).toBe(0);
    expect(rankSearchText(getCurrencyKeywords("NIO"), "ngn")).toBe(0);
  });

  it("matches time zones by IANA name, city and UTC offset aliases", () => {
    const keywords = createTimeZoneKeywords("Asia/Shanghai", new Date("2026-01-01T00:00:00Z"));

    expect(rankSearchText(keywords, "shanghai")).toBeGreaterThan(0);
    expect(rankSearchText(keywords, "Asia Shanghai")).toBeGreaterThan(0);
    expect(rankSearchText(keywords, "utc+8")).toBeGreaterThan(0);
    expect(rankSearchText(keywords, "utc8")).toBeGreaterThan(0);
  });
});

describe("currency select options", () => {
  it("preserves the currency manager order instead of re-ranking common currencies", () => {
    const currencies = [
      "PHP", "AED", "USD", "CNY", "EUR", "NGN", "GBP", "AUD", "TRY", "ARS", "CAD",
    ].map((value) => currencyConfig(value));

    const options = createCurrencySelectOptions({
      currencies,
      currencyOptions: CURRENCY_OPTIONS,
      locale: "zh-CN",
    });

    expect(options.map((option) => option.value)).toEqual([
      "PHP", "AED", "USD", "CNY", "EUR", "NGN", "GBP", "AUD", "TRY", "ARS", "CAD",
    ]);
  });

  it("skips disabled currencies while preserving the remaining manager order", () => {
    const options = createCurrencySelectOptions({
      currencies: [
        currencyConfig("USD", false),
        currencyConfig("CAD"),
        currencyConfig("CNY"),
        currencyConfig("EUR", false),
        currencyConfig("AUD"),
        currencyConfig("GBP"),
      ],
      currencyOptions: CURRENCY_OPTIONS,
      locale: "zh-CN",
    });

    expect(options.map((option) => option.value)).toEqual(["CAD", "CNY", "AUD", "GBP"]);
    expect(options.every((option) => option.disabled !== true)).toBe(true);
  });

  it("keeps a disabled current currency as a non-selectable context item", () => {
    const options = createCurrencySelectOptions({
      currencies: [
        currencyConfig("CNY"),
        currencyConfig("USD", false),
        currencyConfig("EUR"),
      ],
      currencyOptions: CURRENCY_OPTIONS,
      includeDisabledCurrent: "USD",
      locale: "zh-CN",
    });

    expect(options.map((option) => [option.value, option.disabled])).toEqual([
      ["CNY", undefined],
      ["USD", true],
      ["EUR", undefined],
    ]);
    expect(options[1]?.label).toContain("已禁用");
    expect(options[1]?.label).toContain("$ 美元 (USD)");
    expect(options[1]?.label).not.toContain("美元 ($)");
  });
});
