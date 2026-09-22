// 订阅筛选测试保护搜索、标签 OR 语义、有效状态和月成本排序，避免列表页重写筛选规则。
import { describe, expect, it } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import type { Subscription } from "@/types/subscription";
import {
  subscriptionCycleFixture,
  type SubscriptionFixtureOverrides,
} from "@/test/subscription-fixtures";
import { moneyToNumber } from "@renewlet/shared/money";
import {
  DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
  SUBSCRIPTION_SORT_OPTIONS,
  SUBSCRIPTION_PAYMENT_METHOD_NONE_VALUE,
  buildSubscriptionListFilters,
  filterSubscriptions,
  filterSubscriptionsByListFilters,
  hasActiveSubscriptionAdvancedFilters,
  hasActiveSubscriptionFilters,
  sortSubscriptions,
  type SubscriptionFilterState,
  type SubscriptionSortOption,
} from "./subscription-filters";

type SubscriptionBaseFixture = Omit<Subscription, "billingCycle" | "customDays" | "customCycleUnit" | "oneTimeTermCount" | "oneTimeTermUnit">;
type SubscriptionOverrides = SubscriptionFixtureOverrides<Subscription>;

const convert = (amount: number | string, from: string, to: string) => {
  const value = moneyToNumber(amount);
  if (from === to) return value;
  if (from === "USD" && to === "CNY") return value * 7;
  if (from === "CNY" && to === "USD") return value / 7;
  return value;
};

function subscription(overrides: SubscriptionOverrides = {}): Subscription {
  const base: SubscriptionBaseFixture = {
    id: "sub",
    name: "Service",
    logo: undefined,
    price: "10",
    currency: "USD",
    category: "productivity",
    status: "active",
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-01-01"),
    nextBillingDate: assertDateOnly("2026-02-01"),
    autoRenew: true,
    autoCalculateNextBillingDate: true,
    trialEndDate: undefined,
    website: undefined,
    notes: undefined,
    tags: [],
    reminderDays: 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {},
    pinned: false,
    publicHidden: false,
  };

  return {
    ...base,
    ...overrides,
    ...subscriptionCycleFixture(overrides),
  };
}

function sortIds(subscriptions: Subscription[], sortOption: SubscriptionSortOption) {
  return sortSubscriptions(subscriptions, {
    sortOption,
    today: assertDateOnly("2026-01-01"),
    defaultCurrency: "CNY",
    convert,
    locale: "en-US",
  }).map((item) => item.id);
}

describe("subscription sorting", () => {
  it("keeps the backend order for the default sort", () => {
    const subscriptions = [
      subscription({ id: "second" }),
      subscription({ id: "first" }),
    ];

    expect(sortIds(subscriptions, "default")).toEqual(["second", "first"]);
  });

  it("keeps pinned subscriptions ahead for default and field sorting", () => {
    const subscriptions = [
      subscription({ id: "regular-expensive", price: "100" }),
      subscription({ id: "pinned-cheap", price: "10", pinned: true }),
      subscription({ id: "regular-cheap", price: "1" }),
      subscription({ id: "pinned-expensive", price: "80", pinned: true }),
    ];

    expect(sortIds(subscriptions, "default")).toEqual([
      "pinned-cheap",
      "pinned-expensive",
      "regular-expensive",
      "regular-cheap",
    ]);
    expect(sortIds(subscriptions, "price_desc")).toEqual([
      "pinned-expensive",
      "pinned-cheap",
      "regular-expensive",
      "regular-cheap",
    ]);
  });

  it("groups effective active subscriptions before every inactive status inside each pinned group", () => {
    const subscriptions = [
      subscription({ id: "regular-paused", status: "paused", name: "A" }),
      subscription({ id: "regular-active", status: "active", name: "Z" }),
      subscription({ id: "pinned-cancelled", status: "cancelled", pinned: true, name: "A" }),
      subscription({ id: "pinned-trial", status: "trial", pinned: true, name: "Z" }),
      subscription({ id: "legacy-overdue", status: "active", nextBillingDate: assertDateOnly("2025-12-31") }),
      subscription({ id: "explicit-expired-future", status: "expired", nextBillingDate: assertDateOnly("2027-01-01") }),
    ];

    expect(sortIds(subscriptions, "name_asc")).toEqual([
      "pinned-trial",
      "pinned-cancelled",
      "regular-active",
      "regular-paused",
      "legacy-overdue",
      "explicit-expired-future",
    ]);
    const groupRank = new Map([
      ["pinned-trial", 0],
      ["pinned-cancelled", 1],
      ["regular-active", 2],
      ["regular-paused", 3],
      ["legacy-overdue", 3],
      ["explicit-expired-future", 3],
    ]);
    for (const sortOption of SUBSCRIPTION_SORT_OPTIONS) {
      const ranks = sortIds(subscriptions, sortOption).map((id) => groupRank.get(id));
      expect(ranks, sortOption).toEqual([...ranks].sort((left, right) => (left ?? 0) - (right ?? 0)));
    }
  });

  it("sorts by renewal date while preserving tie order", () => {
    const subscriptions = [
      subscription({ id: "later", nextBillingDate: assertDateOnly("2026-04-01") }),
      subscription({ id: "soon-1", nextBillingDate: assertDateOnly("2026-01-10") }),
      subscription({ id: "soon-2", nextBillingDate: assertDateOnly("2026-01-10") }),
    ];

    expect(sortIds(subscriptions, "renewal_asc")).toEqual(["soon-1", "soon-2", "later"]);
    expect(sortIds(subscriptions, "renewal_desc")).toEqual(["later", "soon-1", "soon-2"]);
  });

  it("uses the next trial attention date and keeps permanent buyouts null-last in both directions", () => {
    const subscriptions = [
      subscription({
        id: "trial",
        status: "trial",
        trialEndDate: assertDateOnly("2026-01-05"),
        nextBillingDate: assertDateOnly("2026-02-01"),
      }),
      subscription({
        id: "trial-past-end",
        status: "trial",
        trialEndDate: assertDateOnly("2025-12-20"),
        nextBillingDate: assertDateOnly("2026-01-10"),
      }),
      subscription({
        id: "fixed-term",
        billingCycle: "one-time",
        oneTimeTermCount: 1,
        oneTimeTermUnit: "year",
        nextBillingDate: assertDateOnly("2026-03-01"),
      }),
      subscription({ id: "buyout", billingCycle: "one-time", nextBillingDate: assertDateOnly("2099-01-01") }),
    ];

    expect(sortIds(subscriptions, "renewal_asc")).toEqual([
      "trial",
      "trial-past-end",
      "fixed-term",
      "buyout",
    ]);
    expect(sortIds(subscriptions, "renewal_desc")).toEqual([
      "fixed-term",
      "trial-past-end",
      "trial",
      "buyout",
    ]);
  });

  it("keeps paused and cancelled buyouts out of renewal ordering", () => {
    const subscriptions = [
      subscription({ id: "paused-buyout", status: "paused", billingCycle: "one-time", nextBillingDate: assertDateOnly("1900-01-01") }),
      subscription({ id: "cancelled-recurring", status: "cancelled", nextBillingDate: assertDateOnly("2026-03-01") }),
      subscription({ id: "cancelled-buyout", status: "cancelled", billingCycle: "one-time", nextBillingDate: assertDateOnly("2099-01-01") }),
      subscription({ id: "paused-recurring", status: "paused", nextBillingDate: assertDateOnly("2026-02-01") }),
    ];

    expect(sortIds(subscriptions, "renewal_asc")).toEqual([
      "paused-recurring",
      "cancelled-recurring",
      "paused-buyout",
      "cancelled-buyout",
    ]);
    expect(sortIds(subscriptions, "renewal_desc")).toEqual([
      "cancelled-recurring",
      "paused-recurring",
      "paused-buyout",
      "cancelled-buyout",
    ]);
  });

  it("sorts by monthly cost after currency conversion and cycle normalization", () => {
    const subscriptions = [
      subscription({ id: "annual-usd", price: "120", currency: "USD", billingCycle: "annual" }),
      subscription({ id: "monthly-cny", price: "80", currency: "CNY", billingCycle: "monthly" }),
      subscription({ id: "quarterly-cny", price: "180", currency: "CNY", billingCycle: "quarterly" }),
      subscription({ id: "buyout", price: "1", billingCycle: "one-time" }),
    ];

    expect(sortIds(subscriptions, "monthly_cost_desc")).toEqual([
      "monthly-cny",
      "annual-usd",
      "quarterly-cny",
      "buyout",
    ]);
    expect(sortIds(subscriptions, "monthly_cost_asc")).toEqual([
      "quarterly-cny",
      "annual-usd",
      "monthly-cny",
      "buyout",
    ]);
  });

  it("sorts by raw single-payment price without currency or cycle normalization", () => {
    const subscriptions = [
      subscription({ id: "annual-usd", price: "120", currency: "USD", billingCycle: "annual" }),
      subscription({ id: "monthly-cny", price: "80", currency: "CNY", billingCycle: "monthly" }),
      subscription({ id: "quarterly-cny", price: "180", currency: "CNY", billingCycle: "quarterly" }),
    ];

    expect(sortIds(subscriptions, "price_desc")).toEqual([
      "quarterly-cny",
      "annual-usd",
      "monthly-cny",
    ]);
    expect(sortIds(subscriptions, "price_asc")).toEqual([
      "monthly-cny",
      "annual-usd",
      "quarterly-cny",
    ]);
  });

  it("sorts names with a locale-aware numeric collator", () => {
    const subscriptions = [
      subscription({ id: "alpha-10", name: "Alpha 10" }),
      subscription({ id: "beta", name: "Beta" }),
      subscription({ id: "alpha-2", name: "Alpha 2" }),
    ];

    expect(sortIds(subscriptions, "name_asc")).toEqual(["alpha-2", "alpha-10", "beta"]);
    expect(sortIds(subscriptions, "name_desc")).toEqual(["beta", "alpha-10", "alpha-2"]);
  });
});

describe("subscription filter state", () => {
  const emptyFilters: SubscriptionFilterState = {
    searchQuery: "",
    selectedCategories: [],
    statusFilter: "all",
    paymentTypeFilter: "all",
    selectedTags: [],
  };

  it("detects basic and advanced filters without treating sorting as a filter", () => {
    expect(hasActiveSubscriptionFilters(emptyFilters)).toBe(false);
    expect(hasActiveSubscriptionAdvancedFilters(DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS)).toBe(false);
    expect(hasActiveSubscriptionAdvancedFilters({
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      pinnedFilter: "yes",
    })).toBe(true);

    expect(hasActiveSubscriptionFilters({ ...emptyFilters, searchQuery: "   " })).toBe(false);
    expect(hasActiveSubscriptionFilters({ ...emptyFilters, searchQuery: "cloud" })).toBe(true);
    expect(hasActiveSubscriptionFilters({ ...emptyFilters, selectedCategories: ["finance"] })).toBe(true);
  });

  it("maps basic and advanced filters to product API query filters", () => {
    expect(buildSubscriptionListFilters(emptyFilters)).toBeUndefined();
    expect(buildSubscriptionListFilters(
      {
        searchQuery: "  cursor  ",
        selectedCategories: ["productivity", "finance"],
        statusFilter: "active",
        paymentTypeFilter: "auto",
        selectedTags: ["Team"],
      },
      {
        selectedBillingCycles: ["monthly"],
        selectedPaymentMethods: ["paypal", SUBSCRIPTION_PAYMENT_METHOD_NONE_VALUE],
        selectedCurrencies: ["USD"],
        nextBillingFrom: "2999-08-01",
        nextBillingTo: "2999-08-31",
        pinnedFilter: "yes",
        publicHiddenFilter: "no",
        reminderModeFilter: "custom",
        repeatReminderFilter: "yes",
      },
    )).toEqual({
      q: "cursor",
      category: ["productivity", "finance"],
      tag: ["Team"],
      status: "active",
      paymentType: "auto",
      billingCycle: ["monthly"],
      paymentMethod: ["paypal", "__none"],
      currency: ["USD"],
      nextBillingFrom: "2999-08-01",
      nextBillingTo: "2999-08-31",
      pinned: true,
      publicHidden: false,
      reminderMode: "custom",
      repeatReminder: true,
    });
  });

  it("replays the complete collection query when selecting full DTOs for CSV export", () => {
    const matching = subscription({
      id: "matching",
      name: "Team Mail",
      paymentMethod: undefined,
      reminderDays: -2,
      repeatReminderEnabled: false,
    });
    const unrelated = subscription({
      id: "unrelated",
      name: "Team Mail Archive",
      paymentMethod: "paypal",
      publicHidden: true,
      reminderDays: 7,
      repeatReminderEnabled: true,
    });

    expect(filterSubscriptionsByListFilters([matching, unrelated], {
      q: "team mail",
      billingCycle: ["monthly"],
      paymentMethod: [SUBSCRIPTION_PAYMENT_METHOD_NONE_VALUE],
      currency: ["USD"],
      nextBillingFrom: assertDateOnly("2026-01-01"),
      nextBillingTo: assertDateOnly("2026-12-31"),
      pinned: false,
      publicHidden: false,
      reminderMode: "disabled",
      repeatReminder: false,
    }, { today: assertDateOnly("2026-01-01") }).map((item) => item.id)).toEqual(["matching"]);
  });

  it("filters multiple categories with OR semantics", () => {
    const subscriptions = [
      subscription({ id: "docs", category: "productivity" }),
      subscription({ id: "budget", category: "finance" }),
      subscription({ id: "music", category: "music" }),
    ];
    const context = { today: assertDateOnly("2026-05-18") };

    expect(filterSubscriptions(subscriptions, emptyFilters, context).map((item) => item.id)).toEqual([
      "docs",
      "budget",
      "music",
    ]);
    expect(
      filterSubscriptions(
        subscriptions,
        { ...emptyFilters, selectedCategories: ["productivity", "finance"] },
        context,
      ).map((item) => item.id),
    ).toEqual(["docs", "budget"]);
  });

  it("filters by effective expired status for legacy active subscriptions", () => {
    const subscriptions = [
      subscription({ id: "legacy-overdue", status: "active", nextBillingDate: assertDateOnly("2026-05-15") }),
      subscription({ id: "active-future", status: "active", nextBillingDate: assertDateOnly("2026-05-20") }),
      subscription({ id: "stored-expired", status: "expired", nextBillingDate: assertDateOnly("2026-05-20") }),
      subscription({ id: "paused-overdue", status: "paused", nextBillingDate: assertDateOnly("2026-05-15") }),
    ];

    const expired = filterSubscriptions(
      subscriptions,
      { ...emptyFilters, statusFilter: "expired" },
      { today: assertDateOnly("2026-05-18") },
    );
    const active = filterSubscriptions(
      subscriptions,
      { ...emptyFilters, statusFilter: "active" },
      { today: assertDateOnly("2026-05-18") },
    );

    expect(expired.map((item) => item.id)).toEqual(["legacy-overdue", "stored-expired"]);
    expect(active.map((item) => item.id)).toEqual(["active-future"]);
  });

  it("filters the four mutually exclusive payment types", () => {
    const subscriptions = [
      subscription({ id: "auto", billingCycle: "monthly", autoRenew: true }),
      subscription({ id: "manual", billingCycle: "monthly", autoRenew: false }),
      subscription({ id: "buyout", billingCycle: "one-time", autoRenew: false }),
      subscription({ id: "fixed", billingCycle: "one-time", oneTimeTermCount: 6, oneTimeTermUnit: "month", autoRenew: false }),
    ];
    const context = { today: assertDateOnly("2026-05-18") };

    expect(filterSubscriptions(subscriptions, { ...emptyFilters, paymentTypeFilter: "auto" }, context).map((item) => item.id)).toEqual(["auto"]);
    expect(filterSubscriptions(subscriptions, { ...emptyFilters, paymentTypeFilter: "manual" }, context).map((item) => item.id)).toEqual(["manual"]);
    expect(filterSubscriptions(subscriptions, { ...emptyFilters, paymentTypeFilter: "one-time-buyout" }, context).map((item) => item.id)).toEqual(["buyout"]);
    expect(filterSubscriptions(subscriptions, { ...emptyFilters, paymentTypeFilter: "one-time-fixed-term" }, context).map((item) => item.id)).toEqual(["fixed"]);
  });

  it("excludes buyouts from renewal or expiry date ranges", () => {
    const subscriptions = [
      subscription({ id: "buyout", billingCycle: "one-time", startDate: assertDateOnly("2026-05-15"), nextBillingDate: assertDateOnly("2026-05-15") }),
      subscription({ id: "fixed", billingCycle: "one-time", oneTimeTermCount: 6, oneTimeTermUnit: "month", nextBillingDate: assertDateOnly("2026-05-15") }),
      subscription({ id: "recurring", nextBillingDate: assertDateOnly("2026-05-15") }),
    ];
    expect(filterSubscriptionsByListFilters(subscriptions, {
      nextBillingFrom: assertDateOnly("2026-05-01"),
      nextBillingTo: assertDateOnly("2026-05-31"),
    }, { today: assertDateOnly("2026-05-18") }).map((item) => item.id)).toEqual(["fixed", "recurring"]);
  });
});
