// config 类型测试保护默认配置迁移和内置支付方式/货币策略，避免旧 localStorage 形状污染 UI。
import { describe, expect, it } from "vitest";
import { CATEGORIES, CURRENCY_OPTIONS, SUBSCRIPTION_STATUSES } from "./subscription";
import {
  getDefaultCategories,
  getDefaultCurrencies,
  getDefaultStatuses,
  normalizeCategories,
  normalizeCurrencies,
  normalizeStatuses,
  type ConfigItem,
} from "./config";
import { normalizeCustomConfig } from "@/modules/custom-config/domain/normalize-custom-config";

const legacyCategory = (value: string): ConfigItem => ({
  id: value,
  value,
  labels: {
    "zh-CN": `自定义 ${value}`,
    "en-US": `Custom ${value}`,
  },
  color: `custom-${value}`,
});

describe("category config defaults", () => {
  it("defines the expanded built-in category set with labels and colors", () => {
    const categories = getDefaultCategories();

    expect(CATEGORIES).toHaveLength(23);
    expect(categories.map((category) => category.value)).toEqual([...CATEGORIES]);
    for (const category of categories) {
      expect(category.id).toBe(category.value);
      expect(category.labels["zh-CN"]).toBeTruthy();
      expect(category.labels["en-US"]).toBeTruthy();
      expect(category.color).toMatch(/^hsl\(.+\)$/);
    }
  });

  it("appends new defaults to the legacy four-category config without rewriting existing items", () => {
    const legacyItems = [
      legacyCategory("finance"),
      legacyCategory("productivity"),
      legacyCategory("lifestyle"),
      legacyCategory("entertainment"),
    ];

    const normalized = normalizeCategories(legacyItems);

    expect(normalized).toHaveLength(23);
    expect(normalized.slice(0, legacyItems.length)).toEqual(legacyItems);
    expect(normalized.map((category) => category.value)).toEqual([
      "finance",
      "productivity",
      "lifestyle",
      "entertainment",
      ...CATEGORIES.filter((value) => !legacyItems.some((item) => item.value === value)),
    ]);
  });

  it("does not append built-in categories to a customized category list", () => {
    const customItems = [
      legacyCategory("productivity"),
      legacyCategory("entertainment"),
      legacyCategory("lifestyle"),
      legacyCategory("personal"),
    ];

    expect(normalizeCategories(customItems)).toEqual(customItems);
  });
});

const legacyStatus = (value: string): ConfigItem => ({
  id: `legacy-${value}`,
  value,
  labels: {
    "zh-CN": `旧 ${value}`,
    "en-US": `Legacy ${value}`,
  },
  color: `legacy-${value}`,
});

describe("status config defaults", () => {
  it("defines expired as a built-in status with labels and color", () => {
    const statuses = getDefaultStatuses();

    expect(SUBSCRIPTION_STATUSES).toEqual(["trial", "active", "expired", "paused", "cancelled"]);
    expect(statuses.map((status) => status.value)).toEqual([...SUBSCRIPTION_STATUSES]);
    expect(statuses.find((status) => status.value === "expired")).toMatchObject({
      id: "expired",
      labels: { "zh-CN": "已过期", "en-US": "Expired" },
      color: "hsl(0 72% 51%)",
    });
  });

  it("backfills expired into legacy status configs while preserving built-in order", () => {
    const legacyItems = [
      legacyStatus("active"),
      legacyStatus("trial"),
      legacyStatus("paused"),
      legacyStatus("cancelled"),
    ];

    const normalized = normalizeStatuses(legacyItems);

    expect(normalized.map((status) => status.value)).toEqual([
      "active",
      "trial",
      "paused",
      "cancelled",
      "expired",
    ]);
    expect(normalized.find((status) => status.value === "active")?.labels["zh-CN"]).toBe("活跃");
    expect(normalized.find((status) => status.value === "expired")?.labels["zh-CN"]).toBe("已过期");
  });

  it("drops custom status values so status-driven business logic stays bounded", () => {
    const normalized = normalizeStatuses([
      legacyStatus("active"),
      legacyStatus("archived"),
      legacyStatus("cancelled"),
    ]);

    expect(normalized.map((status) => status.value)).toEqual([
      "active",
      "cancelled",
      "trial",
      "expired",
      "paused",
    ]);
  });
});

const configCurrency = (value: string, enabled = true): ConfigItem => ({
  id: value,
  value,
  labels: {
    "zh-CN": value,
    "en-US": value,
  },
  enabled,
});

const supportedListOrder = CURRENCY_OPTIONS.map((option) => option.value);

describe("currency config defaults", () => {
  it("defines the shared 146-currency exchange-rate scope", () => {
    const currencies = getDefaultCurrencies();

    expect(CURRENCY_OPTIONS).toHaveLength(146);
    expect(currencies).toHaveLength(146);
    expect(currencies.slice(0, 9).map((currency) => currency.value)).toEqual([
      "CNY", "USD", "EUR", "GBP", "AUD", "TRY", "NGN", "ARS", "PHP",
    ]);
    expect(currencies.every((currency) => currency.enabled === true)).toBe(true);
    expect(currencies.map((currency) => currency.value)).toContain("TWD");
    expect(currencies.map((currency) => currency.value)).toContain("VND");
  });

  it("uses the managed default order when currency config is empty", () => {
    const normalized = normalizeCurrencies([]);

    expect(normalized).toEqual(getDefaultCurrencies());
    expect(normalized.slice(0, 9).map((currency) => currency.value)).toEqual([
      "CNY", "USD", "EUR", "GBP", "AUD", "TRY", "NGN", "ARS", "PHP",
    ]);
  });

  it("uses the managed default order when custom config contains an empty currency group", () => {
    const normalized = normalizeCustomConfig({
      categories: [],
      statuses: [],
      paymentMethods: [],
      currencies: [],
    });

    expect(normalized.currencies.slice(0, 9).map((currency) => currency.value)).toEqual([
      "CNY", "USD", "EUR", "GBP", "AUD", "TRY", "NGN", "ARS", "PHP",
    ]);
  });

  it("preserves customized currency order and toggles while appending newly supported currencies", () => {
    const customItems = [
      configCurrency("PHP", true),
      configCurrency("AED", true),
      configCurrency("CNY", false),
      configCurrency("USD", true),
    ];

    const normalized = normalizeCurrencies(customItems);

    expect(normalized).toHaveLength(146);
    expect(normalized.slice(0, 4).map((currency) => [currency.value, currency.enabled])).toEqual([
      ["PHP", true],
      ["AED", true],
      ["CNY", false],
      ["USD", true],
    ]);
    expect(normalized.slice(4, 10).map((currency) => currency.value)).toEqual([
      "EUR", "GBP", "AUD", "TRY", "NGN", "ARS",
    ]);
    expect(normalized.find((currency) => currency.value === "TWD")?.enabled).toBe(true);
  });

  it("preserves a customized full currency order even when every currency remains enabled", () => {
    const customOrder = [
      "PHP",
      ...supportedListOrder.filter((value) => value !== "PHP"),
    ];

    const normalized = normalizeCurrencies(customOrder.map((value) => configCurrency(value, true)));

    expect(normalized.map((currency) => currency.value).slice(0, 4)).toEqual(["PHP", "AED", "AFN", "ALL"]);
    expect(normalized.every((currency) => currency.enabled === true)).toBe(true);
  });

  it("preserves a non-empty saved currency order when the user has disabled a currency", () => {
    const savedItems = supportedListOrder.map((value) => configCurrency(value, value !== "USD"));

    const normalized = normalizeCurrencies(savedItems);

    expect(normalized.map((currency) => currency.value).slice(0, 4)).toEqual(["AED", "AFN", "ALL", "AMD"]);
    expect(normalized.find((currency) => currency.value === "USD")?.enabled).toBe(false);
  });
});
