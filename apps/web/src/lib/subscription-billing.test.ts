// subscription-billing 测试保护周期折算和一次性购买口径，统计页、首页和导出都依赖同一算法。
import { describe, expect, it } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import {
  calculateNextBillingDate,
  calculateOneTimeTermEndDate,
  formatBillingCycleLabel,
  isOneTimeBuyout,
  isOneTimeFixedTerm,
  toMonthlyAmount,
} from "./subscription-billing";

describe("subscription-billing", () => {
  it("calculates the next billing date by adding one cycle to the start date", () => {
    const startDate = assertDateOnly("2026-05-15");

    expect(calculateNextBillingDate(startDate, "weekly")).toBe("2026-05-22");
    expect(calculateNextBillingDate(startDate, "monthly")).toBe("2026-06-15");
    expect(calculateNextBillingDate(startDate, "quarterly")).toBe("2026-08-15");
    expect(calculateNextBillingDate(startDate, "semi-annual")).toBe("2026-11-15");
    expect(calculateNextBillingDate(startDate, "annual")).toBe("2027-05-15");
    expect(calculateNextBillingDate(startDate, "custom", 45, undefined, "day")).toBe("2026-06-29");
    expect(calculateNextBillingDate(startDate, "custom", 2, undefined, "week")).toBe("2026-05-29");
    expect(calculateNextBillingDate(startDate, "custom", 3, undefined, "year")).toBe("2029-05-15");
  });

  it("rejects incomplete custom cycles instead of inventing a default period", () => {
    expect(() => calculateNextBillingDate(assertDateOnly("2026-05-15"), "custom")).toThrow("SUBSCRIPTION_CUSTOM_CYCLE_INVALID");
  });

  it("follows Temporal date-only semantics for month-end and leap-year boundaries", () => {
    expect(calculateNextBillingDate(assertDateOnly("2026-01-31"), "monthly")).toBe("2026-02-28");
    expect(calculateNextBillingDate(assertDateOnly("2024-02-29"), "annual")).toBe("2025-02-28");
    expect(calculateNextBillingDate(assertDateOnly("2026-01-31"), "custom", 1, undefined, "month")).toBe("2026-02-28");
    expect(calculateNextBillingDate(assertDateOnly("2024-02-29"), "custom", 1, undefined, "year")).toBe("2025-02-28");
  });

  it("finds the next billing occurrence on or after the reference date", () => {
    const referenceDate = assertDateOnly("2026-05-17");

    expect(calculateNextBillingDate(assertDateOnly("2025-03-20"), "annual", undefined, referenceDate)).toBe("2027-03-20");
    expect(calculateNextBillingDate(assertDateOnly("2025-03-20"), "monthly", undefined, referenceDate)).toBe("2026-05-20");
    expect(calculateNextBillingDate(assertDateOnly("2026-05-10"), "weekly", undefined, referenceDate)).toBe("2026-05-17");
  });

  it("keeps month and year recurrences anchored to the original start date", () => {
    expect(calculateNextBillingDate(
      assertDateOnly("2026-01-31"),
      "monthly",
      undefined,
      assertDateOnly("2026-03-01"),
    )).toBe("2026-03-31");
    expect(calculateNextBillingDate(
      assertDateOnly("2024-02-29"),
      "annual",
      undefined,
      assertDateOnly("2025-03-01"),
    )).toBe("2026-02-28");
  });

  it("keeps one-time purchases out of recurrence and monthly cost calculations", () => {
    const startDate = assertDateOnly("2026-05-15");

    expect(calculateNextBillingDate(startDate, "one-time", undefined, assertDateOnly("2027-01-01"))).toBe(startDate);
    expect(toMonthlyAmount(199, "one-time")).toBe(0);
    expect(isOneTimeBuyout({ billingCycle: "one-time", oneTimeTermCount: undefined, oneTimeTermUnit: undefined })).toBe(true);
    expect(isOneTimeFixedTerm({ billingCycle: "one-time", oneTimeTermCount: undefined, oneTimeTermUnit: undefined })).toBe(false);
  });

  it("amortizes one-time fixed terms into monthly amounts", () => {
    expect(toMonthlyAmount(90, "one-time", undefined, "day", 90, "day")).toBe(30);
    expect(toMonthlyAmount(10, "one-time", undefined, "day", 2, "week")).toBe(21.65);
    expect(toMonthlyAmount(120, "one-time", undefined, "day", 3, "month")).toBe(40);
    expect(toMonthlyAmount(360, "one-time", undefined, "day", 3, "year")).toBe(10);
    expect(isOneTimeFixedTerm({ billingCycle: "one-time", oneTimeTermCount: 3, oneTimeTermUnit: "month" })).toBe(true);
    expect(isOneTimeBuyout({ billingCycle: "one-time", oneTimeTermCount: 3, oneTimeTermUnit: "month" })).toBe(false);
  });

  it("calculates one-time fixed term expiry dates with date-only semantics", () => {
    expect(calculateOneTimeTermEndDate(assertDateOnly("2026-01-31"), 1, "month")).toBe("2026-02-28");
    expect(calculateOneTimeTermEndDate(assertDateOnly("2026-05-15"), 2, "week")).toBe("2026-05-29");
    expect(calculateOneTimeTermEndDate(assertDateOnly("2024-02-29"), 1, "year")).toBe("2025-02-28");
  });

  it("converts custom cycle units to monthly amounts", () => {
    expect(toMonthlyAmount(30, "custom", 15, "day")).toBe(60);
    expect(toMonthlyAmount(10, "custom", 2, "week")).toBe(21.65);
    expect(toMonthlyAmount(120, "custom", 3, "month")).toBe(40);
    expect(toMonthlyAmount(360, "custom", 3, "year")).toBe(10);
  });

  it("formats custom cycle labels with concrete units", () => {
    expect(formatBillingCycleLabel({
      billingCycle: "custom",
      customDays: 3,
      customCycleUnit: "year",
    }, "zh-CN")).toBe("每 3 年");
    expect(formatBillingCycleLabel({
      billingCycle: "custom",
      customDays: 2,
      customCycleUnit: "week",
    }, "en-US")).toBe("Every 2 weeks");
  });
});
