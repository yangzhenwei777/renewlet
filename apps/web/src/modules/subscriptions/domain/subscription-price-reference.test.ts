import { describe, expect, it } from "vitest";
import { getSubscriptionPriceReference, resolveSubscriptionPriceReferenceCurrency } from "./subscription-price-reference";

describe("getSubscriptionPriceReference", () => {
  const convert = (amount: number | string, fromCurrency: string, toCurrency: string) => {
    const value = typeof amount === "number" ? amount : Number(amount);
    if (fromCurrency === "USD" && toCurrency === "CNY") return value * 7;
    if (fromCurrency === "USD" && toCurrency === "EUR") return value * 0.9;
    return value;
  };

  it("converts supported foreign-currency subscriptions to the configured reference currency", () => {
    expect(getSubscriptionPriceReference({
      price: "15",
      currency: "USD",
      targetCurrency: "CNY",
      currencyRatesReady: true,
      currencyConvert: convert,
    })).toEqual({ amount: 105, currency: "CNY" });

    expect(getSubscriptionPriceReference({
      price: "15",
      currency: "USD",
      targetCurrency: "EUR",
      currencyRatesReady: true,
      currencyConvert: convert,
    })).toEqual({ amount: 13.5, currency: "EUR" });
  });

  it("hides the reference for same-currency subscriptions", () => {
    expect(getSubscriptionPriceReference({
      price: "15",
      currency: "CNY",
      targetCurrency: "CNY",
      currencyRatesReady: true,
      currencyConvert: convert,
    })).toBeNull();
  });

  it("hides the reference for zero-price subscriptions", () => {
    expect(getSubscriptionPriceReference({
      price: "0",
      currency: "USD",
      targetCurrency: "CNY",
      currencyRatesReady: true,
      currencyConvert: convert,
    })).toBeNull();
  });

  it("hides the reference for unsupported currencies", () => {
    expect(getSubscriptionPriceReference({
      price: "15",
      currency: "XXX",
      targetCurrency: "CNY",
      currencyRatesReady: true,
      currencyConvert: convert,
    })).toBeNull();

    expect(getSubscriptionPriceReference({
      price: "15",
      currency: "USD",
      targetCurrency: "XXX",
      currencyRatesReady: true,
      currencyConvert: convert,
    })).toBeNull();
  });

  it("hides the reference before a real exchange-rate source is ready", () => {
    expect(getSubscriptionPriceReference({
      price: "15",
      currency: "USD",
      targetCurrency: "CNY",
      currencyRatesReady: false,
      currencyConvert: convert,
    })).toBeNull();
  });

  it("hides invalid conversion results", () => {
    expect(getSubscriptionPriceReference({
      price: "15",
      currency: "USD",
      targetCurrency: "CNY",
      currencyRatesReady: true,
      currencyConvert: () => Number.POSITIVE_INFINITY,
    })).toBeNull();
    expect(getSubscriptionPriceReference({
      price: "15",
      currency: "USD",
      targetCurrency: "CNY",
      currencyRatesReady: true,
      currencyConvert: () => Number.NaN,
    })).toBeNull();
  });
});

describe("resolveSubscriptionPriceReferenceCurrency", () => {
  it("returns null while the feature is disabled", () => {
    expect(resolveSubscriptionPriceReferenceCurrency({
      defaultCurrency: "USD",
      subscriptionPriceReferenceEnabled: false,
      subscriptionPriceReferenceCurrency: "CNY",
    })).toBeNull();
  });

  it("resolves default to the account default currency", () => {
    expect(resolveSubscriptionPriceReferenceCurrency({
      defaultCurrency: "USD",
      subscriptionPriceReferenceEnabled: true,
      subscriptionPriceReferenceCurrency: "default",
    })).toBe("USD");
  });

  it("resolves an explicit configured currency", () => {
    expect(resolveSubscriptionPriceReferenceCurrency({
      defaultCurrency: "USD",
      subscriptionPriceReferenceEnabled: true,
      subscriptionPriceReferenceCurrency: "eur",
    })).toBe("EUR");
  });
});
