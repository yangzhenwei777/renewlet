import { describe, expect, it } from "vitest";
import {
  getAdvancedSelectionPreview,
  getAdvancedOptionListSearchResults,
  getAdvancedOptionListSections,
  type SubscriptionAdvancedFilterOption,
} from "./subscription-advanced-filter-options";

function option(value: string, label = value, keywords: string[] = []): SubscriptionAdvancedFilterOption {
  return { value, label, keywords };
}

describe("advanced option list sections", () => {
  it("keeps the full payment method list in input order", () => {
    const options = [
      option("__none", "No payment method"),
      option("card", "Credit card"),
      option("paypal", "PayPal"),
      option("bank", "Bank transfer"),
    ];

    const sections = getAdvancedOptionListSections({
      options,
    });

    expect(sections.allOptions.map((item) => item.value)).toEqual(["__none", "card", "paypal", "bank"]);
  });

  it("does not move selected currencies out of the full list", () => {
    const options = [
      option("AED"),
      option("AUD"),
      option("BRL"),
      option("CAD"),
      option("CHF"),
      option("CNY"),
      option("EUR"),
      option("GBP"),
      option("JPY"),
      ...Array.from({ length: 137 }, (_, index) => option(`X${index}`)),
    ];

    const sections = getAdvancedOptionListSections({
      options,
    });

    expect(sections.allOptions).toHaveLength(options.length);
    expect(sections.allOptions.map((item) => item.value)).toContain("JPY");
  });

  it("preserves the currency option order supplied by the currency manager", () => {
    const options = [
      option("CNY"),
      option("EUR"),
      ...Array.from({ length: 20 }, (_, index) => option(`X${index}`)),
      option("USD"),
    ];

    const sections = getAdvancedOptionListSections({
      options,
    });

    expect(sections.allOptions.map((item) => item.value)).toEqual(options.map((item) => item.value));
    expect(sections.allOptions.map((item) => item.value)).toContain("X19");
    expect(sections.allOptions.map((item) => item.value)).toContain("USD");
  });

  it("searches the full option set by code, label, and keywords", () => {
    const options = [
      option("CNY", "¥ 人民币 (CNY)", ["人民币", "yuan"]),
      option("EUR", "€ 欧元 (EUR)", ["Euro"]),
      ...Array.from({ length: 20 }, (_, index) => option(`X${index}`)),
      option("USD", "$ 美元 (USD)", ["美元", "$", "US Dollar"]),
    ];
    const usd = options[options.length - 1];

    expect(getAdvancedOptionListSearchResults({ options, searchQuery: "USD" })).toEqual([usd]);
    expect(getAdvancedOptionListSearchResults({ options, searchQuery: "美元" })).toEqual([usd]);
    expect(getAdvancedOptionListSearchResults({ options, searchQuery: "$" })).toEqual([usd]);
  });

  it("keeps search results in input order even when a later option has a stronger match", () => {
    const options = [
      option("CNY", "¥ 人民币 (CNY) with USD reference", ["reference usd"]),
      option("USD", "$ 美元 (USD)", ["美元", "$", "US Dollar"]),
      option("EUR", "€ 欧元 (EUR)", ["Euro"]),
    ];

    expect(getAdvancedOptionListSearchResults({ options, searchQuery: "usd" }).map((item) => item.value))
      .toEqual(["CNY", "USD"]);
  });

  it("keeps single-character currency search results relevant and in manager order", () => {
    const options = [
      option("GBP", "£ 英镑 (GBP)", ["pound sterling", "global", "currency"]),
      option("AUD", "AU$ 澳大利亚元 (AUD)", ["Australian dollar"]),
      option("USD", "$ 美元 (USD)", ["美元", "US Dollar"]),
      option("TRY", "₺ 土耳其里拉 (TRY)", ["Turkish lira"]),
      option("UGX", "UGX 乌干达先令", ["Ugandan Shilling"]),
      option("PHP", "₱ 菲律宾比索 (PHP)", ["Philippine peso", "currency"]),
    ];

    expect(getAdvancedOptionListSearchResults({ options, searchQuery: "u" }).map((item) => item.value))
      .toEqual(["USD", "UGX"]);
  });

  it("returns an empty list when search has no match", () => {
    const options = [option("CNY"), option("USD")];

    expect(getAdvancedOptionListSearchResults({ options, searchQuery: "zzzz" })).toEqual([]);
  });

  it("builds a selected value preview without moving options", () => {
    const options = [
      option("card", "Credit card"),
      option("paypal", "PayPal"),
      option("bank", "Bank transfer"),
      option("apple", "Apple Pay"),
    ];

    expect(getAdvancedSelectionPreview({
      values: [],
      options,
      separator: ", ",
      overflowLabel: (count) => `+${count}`,
    })).toBeUndefined();
    expect(getAdvancedSelectionPreview({
      values: ["paypal", "card", "bank", "apple"],
      options,
      separator: ", ",
      overflowLabel: (count) => `+${count}`,
    })).toBe("PayPal, Credit card, Bank transfer +1");
  });
});
