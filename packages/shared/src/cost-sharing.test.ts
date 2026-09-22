import { describe, expect, it } from "vitest";
import {
  calculateCostSharingMemberAmount,
  calculateCostSharingSummary,
  costSharingCollectionAnchorsAreSatisfied,
  costSharingCustomAmountsAreValid,
  costSharingCollectionReminderOccurrencesForDate,
  nextCostSharingCollectionReminderDate,
  type CostSharing,
} from "./cost-sharing";
import { moneyToNumber } from "./money";
import { isValidDateOnly, type DateOnly } from "./runtime";

function dateOnly(value: string): DateOnly {
  if (!isValidDateOnly(value)) throw new Error(`Invalid test date-only value: ${value}`);
  return value as DateOnly;
}

const equalSharing: CostSharing = {
  enabled: true,
  splitMode: "equal",
  members: [
    { id: "partner", name: "Partner" },
    { id: "child", name: "Child" },
  ],
};

describe("cost sharing calculation", () => {
  it("splits equal shares between the current payer and shared members", () => {
    const summary = calculateCostSharingSummary(equalSharing, 90);

    expect(calculateCostSharingMemberAmount(equalSharing, equalSharing.members[0]!, 90)).toBe(30);
    expect(summary).toMatchObject({
      enabled: true,
      total: 90,
      yourShare: 30,
      memberTotal: 60,
      recoverableAmount: 60,
      memberCount: 2,
    });
  });

  it("treats custom member totals below the price as partial recovery", () => {
    const customSharing: CostSharing = {
      enabled: true,
      splitMode: "custom",
      members: [
        { id: "partner", name: "Partner", currency: "CNY", customAmount: "10" },
        { id: "child", name: "Child", currency: "CNY", customAmount: "10" },
      ],
    };

    expect(costSharingCustomAmountsAreValid(customSharing)).toBe(true);
    expect(calculateCostSharingSummary(customSharing, 50, { baseCurrency: "CNY" })).toMatchObject({
      yourShare: 30,
      memberTotal: 20,
      recoverableAmount: 20,
    });
  });

  it("allows custom member totals to match the price exactly", () => {
    const customSharing: CostSharing = {
      enabled: true,
      splitMode: "custom",
      members: [
        { id: "partner", name: "Partner", currency: "CNY", customAmount: "20" },
        { id: "child", name: "Child", currency: "CNY", customAmount: "30" },
      ],
    };

    expect(calculateCostSharingSummary(customSharing, 50, { baseCurrency: "CNY" })).toMatchObject({
      yourShare: 0,
      memberTotal: 50,
      recoverableAmount: 50,
    });
  });

  it("allows custom member totals to exceed the price without creating an overage field", () => {
    const customSharing: CostSharing = {
      enabled: true,
      splitMode: "custom",
      members: [
        { id: "partner", name: "Partner", currency: "CNY", customAmount: "50" },
        { id: "child", name: "Child", currency: "CNY", customAmount: "30" },
      ],
    };

    expect(calculateCostSharingSummary(customSharing, 50, { baseCurrency: "CNY" })).toMatchObject({
      yourShare: 0,
      memberTotal: 80,
      recoverableAmount: 80,
    });
  });

  it("converts custom member currencies before comparing with the subscription price", () => {
    const customSharing: CostSharing = {
      enabled: true,
      splitMode: "custom",
      members: [
        { id: "eur", name: "EUR member", currency: "EUR", customAmount: "10" },
        { id: "usd", name: "USD member", currency: "USD", customAmount: "10" },
        { id: "gbp", name: "GBP member", currency: "GBP", customAmount: "10" },
        { id: "jpy", name: "JPY member", currency: "JPY", customAmount: "10" },
      ],
    };
    const convert = (amount: number | string, from: string, to: string) => {
      const value = moneyToNumber(amount);
      if (to !== "CNY") return value;
      const rates: Record<string, number> = {
        CNY: 1,
        EUR: 8,
        USD: 7,
        GBP: 9,
        JPY: 0.05,
      };
      return value * (rates[from] ?? 1);
    };

    expect(calculateCostSharingSummary(customSharing, 50, { baseCurrency: "CNY", convert })).toMatchObject({
      yourShare: 0,
      memberTotal: 240.5,
      recoverableAmount: 240.5,
      memberCount: 4,
    });
  });

  it("rejects missing custom amounts for shared members", () => {
    expect(costSharingCustomAmountsAreValid({
      enabled: true,
      splitMode: "custom",
      members: [
        { id: "partner", name: "Partner", currency: "USD", customAmount: "40" },
        { id: "child", name: "Child", currency: "CNY" },
      ],
    })).toBe(false);
  });
});

describe("cost sharing collection reminder dates", () => {
  const quarterlySharing: CostSharing = {
    enabled: true,
    splitMode: "equal",
    collectionReminder: { enabled: true, reminderDays: 1 },
    members: [
      { id: "jan", name: "Jan", joinedDate: dateOnly("2026-01-15") },
      { id: "feb", name: "Feb", joinedDate: dateOnly("2026-02-10") },
    ],
  };

  it("calculates member collection dates from each joined date", () => {
    const janItems = costSharingCollectionReminderOccurrencesForDate({
      costSharing: quarterlySharing,
      subscriptionStartDate: null,
      nextBillingDate: "2026-04-15",
      billingCycle: "quarterly",
      notificationReminderDays: 3,
      referenceDate: "2026-04-14",
    });
    const febItems = costSharingCollectionReminderOccurrencesForDate({
      costSharing: quarterlySharing,
      subscriptionStartDate: null,
      nextBillingDate: "2026-05-10",
      billingCycle: "quarterly",
      notificationReminderDays: 3,
      referenceDate: "2026-05-09",
    });

    expect(janItems.map((item) => [item.member.id, item.targetDate, item.reminderDate])).toEqual([
      ["jan", "2026-04-15", "2026-04-14"],
    ]);
    expect(febItems.map((item) => [item.member.id, item.targetDate, item.reminderDate])).toEqual([
      ["feb", "2026-05-10", "2026-05-09"],
    ]);
  });

  it("inherits the subscription start date when a member joined date is empty", () => {
    const costSharing: CostSharing = {
      enabled: true,
      splitMode: "equal",
      collectionReminder: { enabled: true, reminderDays: -1 },
      members: [{ id: "partner", name: "Partner" }],
    };

    expect(costSharingCollectionAnchorsAreSatisfied(costSharing, "2026-01-01")).toBe(true);
    expect(costSharingCollectionReminderOccurrencesForDate({
      costSharing,
      subscriptionStartDate: "2026-01-01",
      nextBillingDate: "2026-07-01",
      billingCycle: "semi-annual",
      notificationReminderDays: 2,
      referenceDate: "2026-06-29",
    })).toMatchObject([
      { targetDate: "2026-07-01", reminderDate: "2026-06-29", reminderDays: 2 },
    ]);
  });

  it("returns the earliest indexed reminder date across members", () => {
    expect(nextCostSharingCollectionReminderDate({
      costSharing: quarterlySharing,
      subscriptionStartDate: null,
      nextBillingDate: "2026-04-15",
      billingCycle: "quarterly",
      notificationReminderDays: 3,
      referenceDate: "2026-04-14",
    })).toBe("2026-04-14");
    expect(nextCostSharingCollectionReminderDate({
      costSharing: quarterlySharing,
      subscriptionStartDate: null,
      nextBillingDate: "2026-05-10",
      billingCycle: "quarterly",
      notificationReminderDays: 3,
      referenceDate: "2026-04-15",
    })).toBe("2026-05-09");
  });

  it("requires an anchor for every member when the subscription start date is unknown", () => {
    expect(costSharingCollectionAnchorsAreSatisfied({
      enabled: true,
      splitMode: "equal",
      collectionReminder: { enabled: true, reminderDays: 0 },
      members: [{ id: "missing", name: "Missing" }],
    }, null)).toBe(false);
  });

  it("inherits weekly and custom day/week billing cycles without monthly approximation", () => {
    const weeklySharing: CostSharing = {
      enabled: true,
      splitMode: "equal",
      collectionReminder: { enabled: true, reminderDays: 2 },
      members: [{ id: "partner", name: "Partner", joinedDate: dateOnly("2026-01-05") }],
    };
    const customWeekSharing: CostSharing = {
      ...weeklySharing,
      collectionReminder: { enabled: true, reminderDays: 1 },
    };

    expect(costSharingCollectionReminderOccurrencesForDate({
      costSharing: weeklySharing,
      subscriptionStartDate: null,
      nextBillingDate: "2026-01-12",
      billingCycle: "weekly",
      notificationReminderDays: 3,
      referenceDate: "2026-01-10",
    })).toMatchObject([{ targetDate: "2026-01-12", reminderDate: "2026-01-10" }]);

    expect(costSharingCollectionReminderOccurrencesForDate({
      costSharing: customWeekSharing,
      subscriptionStartDate: null,
      nextBillingDate: "2026-01-19",
      billingCycle: "custom",
      customDays: 2,
      customCycleUnit: "week",
      notificationReminderDays: 3,
      referenceDate: "2026-01-18",
    })).toMatchObject([{ targetDate: "2026-01-19", reminderDate: "2026-01-18" }]);
  });

  it("inherits custom month and year cycles with calendar clamping", () => {
    const costSharing: CostSharing = {
      enabled: true,
      splitMode: "equal",
      collectionReminder: { enabled: true, reminderDays: 0 },
      members: [{ id: "partner", name: "Partner", joinedDate: dateOnly("2026-01-31") }],
    };

    expect(costSharingCollectionReminderOccurrencesForDate({
      costSharing,
      subscriptionStartDate: null,
      nextBillingDate: "2026-02-28",
      billingCycle: "custom",
      customDays: 1,
      customCycleUnit: "month",
      notificationReminderDays: 3,
      referenceDate: "2026-02-28",
    })).toMatchObject([{ targetDate: "2026-02-28", reminderDate: "2026-02-28" }]);

    expect(costSharingCollectionReminderOccurrencesForDate({
      costSharing,
      subscriptionStartDate: null,
      nextBillingDate: "2027-01-31",
      billingCycle: "custom",
      customDays: 1,
      customCycleUnit: "year",
      notificationReminderDays: 3,
      referenceDate: "2027-01-31",
    })).toMatchObject([{ targetDate: "2027-01-31", reminderDate: "2027-01-31" }]);
  });

  it("sends one fixed-term one-time collection reminder and skips buyouts", () => {
    const costSharing: CostSharing = {
      enabled: true,
      splitMode: "equal",
      collectionReminder: { enabled: true, reminderDays: 3 },
      members: [{ id: "partner", name: "Partner", joinedDate: dateOnly("2026-01-01") }],
    };

    expect(costSharingCollectionReminderOccurrencesForDate({
      costSharing,
      subscriptionStartDate: "2026-01-01",
      nextBillingDate: "2026-04-01",
      billingCycle: "one-time",
      oneTimeTermCount: 3,
      oneTimeTermUnit: "month",
      notificationReminderDays: 3,
      referenceDate: "2026-03-29",
    })).toMatchObject([{ targetDate: "2026-04-01", reminderDate: "2026-03-29" }]);

    expect(nextCostSharingCollectionReminderDate({
      costSharing,
      subscriptionStartDate: "2026-01-01",
      nextBillingDate: "2026-04-01",
      billingCycle: "one-time",
      notificationReminderDays: 3,
      referenceDate: "2026-03-29",
    })).toBeNull();
  });
});
