import { describe, expect, it } from "vitest";
import { currencyRegionHints, type CurrencyRegionHints } from "@renewlet/shared/currency-region-hints";
import { SUPPORTED_EXCHANGE_RATE_CURRENCIES } from "@/lib/currency-data";
import { inferSubscriptionPriceReferenceCurrency } from "./subscription-price-reference-currency-local-preference";

describe("inferSubscriptionPriceReferenceCurrency", () => {
  it("infers a local preference only when explicit language region and timezone agree", () => {
    expect(inferSubscriptionPriceReferenceCurrency({
      languages: ["zh-CN"],
      timeZone: "Asia/Shanghai",
    })).toEqual({ currency: "CNY", reason: "locale-timezone" });

    expect(inferSubscriptionPriceReferenceCurrency({
      languages: ["en-US"],
      timeZone: "America/New_York",
    })).toEqual({ currency: "USD", reason: "locale-timezone" });

    expect(inferSubscriptionPriceReferenceCurrency({
      languages: ["en-GB"],
      timeZone: "Europe/London",
    })).toEqual({ currency: "GBP", reason: "locale-timezone" });
  });

  it("does not infer a local preference when language region conflicts with timezone", () => {
    expect(inferSubscriptionPriceReferenceCurrency({
      languages: ["en-US"],
      timeZone: "Europe/London",
    })).toBeNull();
    expect(inferSubscriptionPriceReferenceCurrency({
      languages: ["zh-CN"],
      timeZone: "America/New_York",
    })).toBeNull();
  });

  it("uses a unique timezone currency as the local preference when there is no explicit language region", () => {
    expect(inferSubscriptionPriceReferenceCurrency({
      languages: ["en"],
      timeZone: "Europe/London",
    })).toEqual({ currency: "GBP", reason: "timezone" });
  });

  it("supports multi-territory timezones when all territories share one currency", () => {
    expect(inferSubscriptionPriceReferenceCurrency({
      languages: [],
      timeZone: "Europe/Helsinki",
    })).toEqual({ currency: "EUR", reason: "timezone" });
  });

  it("rejects multi-currency, missing timezone, missing region, and unsupported hints", () => {
    const multiCurrencyHints: CurrencyRegionHints = {
      sourceVersion: currencyRegionHints.sourceVersion,
      timeZoneTerritories: { "Etc/Mixed": ["US", "GB"] },
      territoryCurrencies: { US: "USD", GB: "GBP" },
    };
    const unsupportedHints: CurrencyRegionHints = {
      sourceVersion: currencyRegionHints.sourceVersion,
      timeZoneTerritories: { "Etc/Unsupported": ["AQ"] },
      territoryCurrencies: { AQ: "XXX" },
    };

    expect(inferSubscriptionPriceReferenceCurrency({
      languages: [],
      timeZone: "Etc/Mixed",
      hints: multiCurrencyHints,
    })).toBeNull();
    expect(inferSubscriptionPriceReferenceCurrency({ languages: ["zh-CN"], timeZone: null })).toBeNull();
    expect(inferSubscriptionPriceReferenceCurrency({ languages: ["zh"], timeZone: "Etc/UTC" })).toBeNull();
    expect(inferSubscriptionPriceReferenceCurrency({
      languages: [],
      timeZone: "Etc/Unsupported",
      hints: unsupportedHints,
    })).toBeNull();
  });
});

describe("currency-region static data", () => {
  it("only contains currencies supported by the exchange-rate converter", () => {
    const supported = new Set<string>(SUPPORTED_EXCHANGE_RATE_CURRENCIES);
    expect(Object.values(currencyRegionHints.territoryCurrencies).every((currency) => supported.has(currency))).toBe(true);
  });
});
