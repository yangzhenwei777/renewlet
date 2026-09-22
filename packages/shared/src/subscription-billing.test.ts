import { describe, expect, it } from "vitest";
import {
  calculateNextBillingDate,
  calculateOneTimeTermEndDate,
  isOneTimeBuyout,
  isOneTimeFixedTerm,
  projectSubscriptionDailyCost,
  toDailyAmountFromMonthly,
  toMonthlyAmount,
  toSubscriptionMonthlyAmount,
} from "./subscription-billing";

describe("subscription-billing", () => {
  it("converts recurring billing cycles to monthly amounts", () => {
    expect(toMonthlyAmount(10, "weekly")).toBe(43.3);
    expect(toMonthlyAmount(30, "monthly")).toBe(30);
    expect(toMonthlyAmount(90, "quarterly")).toBe(30);
    expect(toMonthlyAmount(180, "semi-annual")).toBe(30);
    expect(toMonthlyAmount(360, "annual")).toBe(30);
  });

  it("converts custom cycle units to monthly amounts", () => {
    expect(toMonthlyAmount(30, "custom", 15, "day")).toBe(60);
    expect(toMonthlyAmount(10, "custom", 2, "week")).toBe(21.65);
    expect(toMonthlyAmount(120, "custom", 3, "month")).toBe(40);
    expect(toMonthlyAmount(360, "custom", 3, "year")).toBe(10);
  });

  it("amortizes one-time fixed terms and excludes buyouts", () => {
    expect(toMonthlyAmount(199, "one-time")).toBe(0);
    expect(toMonthlyAmount(90, "one-time", undefined, "day", 90, "day")).toBe(30);
    expect(toMonthlyAmount(10, "one-time", undefined, "day", 2, "week")).toBe(21.65);
    expect(toMonthlyAmount(120, "one-time", undefined, "day", 3, "month")).toBe(40);
    expect(toMonthlyAmount(360, "one-time", undefined, "day", 3, "year")).toBe(10);
    expect(isOneTimeFixedTerm({ billingCycle: "one-time", oneTimeTermCount: 3, oneTimeTermUnit: "month" })).toBe(true);
    expect(isOneTimeFixedTerm({ billingCycle: "one-time", oneTimeTermCount: 3, oneTimeTermUnit: undefined })).toBe(true);
    expect(isOneTimeBuyout({ billingCycle: "one-time", oneTimeTermCount: undefined, oneTimeTermUnit: undefined })).toBe(true);
    expect(isOneTimeBuyout({ billingCycle: "one-time", oneTimeTermCount: 0, oneTimeTermUnit: undefined })).toBe(true);
    expect(isOneTimeBuyout({ billingCycle: "one-time", oneTimeTermCount: -1, oneTimeTermUnit: "month" })).toBe(true);
    expect(toMonthlyAmount(199, "one-time", undefined, undefined, -1, "month")).toBe(0);
  });

  it("converts subscription-shaped billing fields", () => {
    expect(toSubscriptionMonthlyAmount(120, {
      billingCycle: "custom",
      customDays: 3,
      customCycleUnit: "month",
    })).toBe(40);
    expect(toSubscriptionMonthlyAmount(240, {
      billingCycle: "one-time",
      oneTimeTermCount: 2,
      oneTimeTermUnit: "year",
    })).toBe(10);
  });

  it("derives standardized daily amounts from normalized monthly amounts", () => {
    const normalizedMonthlyAmounts = [
      toMonthlyAmount(30, "monthly"),
      toMonthlyAmount(360, "annual"),
      toMonthlyAmount(10, "weekly"),
      toMonthlyAmount(30, "custom", 15, "day"),
      toMonthlyAmount(10, "custom", 2, "week"),
      toMonthlyAmount(120, "custom", 3, "month"),
      toMonthlyAmount(360, "custom", 3, "year"),
      toMonthlyAmount(90, "one-time", undefined, "day", 90, "day"),
      toMonthlyAmount(10, "one-time", undefined, "day", 2, "week"),
      toMonthlyAmount(120, "one-time", undefined, "day", 3, "month"),
      toMonthlyAmount(360, "one-time", undefined, "day", 3, "year"),
    ];

    for (const monthlyAmount of normalizedMonthlyAmounts) {
      expect(toDailyAmountFromMonthly(monthlyAmount)).toBe(monthlyAmount / 30);
    }
    expect(toDailyAmountFromMonthly(toMonthlyAmount(199, "one-time"))).toBe(0);
    expect(toDailyAmountFromMonthly(0)).toBe(0);
  });

  it("projects recurring and fixed-term daily costs on the normalized basis", () => {
    expect(projectSubscriptionDailyCost("30", { billingCycle: "monthly" }, "2026-03-08")).toEqual({
      amount: "1",
      basis: "normalized",
    });
    expect(projectSubscriptionDailyCost("90", {
      billingCycle: "one-time",
      startDate: "2026-01-01",
      oneTimeTermCount: 90,
      oneTimeTermUnit: "day",
    }, "2026-03-08")).toEqual({ amount: "1", basis: "normalized" });
  });

  it("projects buyout cost over ownership date-only days", () => {
    expect(projectSubscriptionDailyCost("100", {
      billingCycle: "one-time",
      startDate: "2026-03-08",
    }, "2026-03-08")).toEqual({ amount: "100", basis: "ownership-to-date" });
    expect(projectSubscriptionDailyCost("31", {
      billingCycle: "one-time",
      startDate: "2026-01-31",
    }, "2026-03-01")).toEqual({ amount: "1.033333", basis: "ownership-to-date" });
    expect(projectSubscriptionDailyCost("3", {
      billingCycle: "one-time",
      startDate: "2024-02-28",
    }, "2024-03-01")).toEqual({ amount: "1", basis: "ownership-to-date" });
  });

  it("keeps ownership projection independent from DST instants and handles edge inputs", () => {
    expect(projectSubscriptionDailyCost("20", {
      billingCycle: "one-time",
      startDate: "2026-03-08",
    }, "2026-03-09")).toEqual({ amount: "10", basis: "ownership-to-date" });
    expect(projectSubscriptionDailyCost("0", {
      billingCycle: "one-time",
      startDate: "2026-03-08",
    }, "2026-03-09")).toEqual({ amount: "0", basis: "ownership-to-date" });
    expect(projectSubscriptionDailyCost("1", {
      billingCycle: "one-time",
      startDate: "2026-03-08",
    }, "2026-03-10")).toEqual({ amount: "0.333333", basis: "ownership-to-date" });
    expect(projectSubscriptionDailyCost("20", { billingCycle: "one-time" }, "2026-03-09")).toBeNull();
    expect(projectSubscriptionDailyCost("20", {
      billingCycle: "one-time",
      startDate: "not-a-date",
    }, "2026-03-09")).toBeNull();
    expect(projectSubscriptionDailyCost("20", {
      billingCycle: "one-time",
      startDate: "2026-03-10",
    }, "2026-03-09")).toBeNull();
    expect(projectSubscriptionDailyCost("20", {
      billingCycle: "one-time",
      oneTimeTermCount: -1,
      oneTimeTermUnit: "month",
      startDate: "2026-03-08",
    }, "2026-03-09")).toEqual({ amount: "10", basis: "ownership-to-date" });
  });

  it("uses date-only renewal semantics for next billing and one-time term end dates", () => {
    expect(calculateNextBillingDate("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(calculateNextBillingDate("2024-02-29", "annual")).toBe("2025-02-28");
    expect(calculateNextBillingDate("2025-03-20", "monthly", undefined, "2026-05-17")).toBe("2026-05-20");
    expect(calculateOneTimeTermEndDate("2026-01-31", 1, "month")).toBe("2026-02-28");
    expect(calculateOneTimeTermEndDate("2024-02-29", 1, "year")).toBe("2025-02-28");
  });
});
