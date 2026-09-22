// 订阅 schema 测试保护 logo 私有资产路径、http(s) 外链和 date-only 字段的运行时契约。
import { describe, expect, it } from "vitest";
import { apiSubscriptionSchema, subscriptionsListResponseSchema, subscriptionCreateBodySchema } from "./subscriptions";

const success = <T>(data: T) => ({ ok: true, data });

const validSubscriptionCreateBody = {
  name: "Logo Test",
  logo: null,
  price: "0.83",
  currency: "CNY",
  billingCycle: "monthly",
  customDays: null,
  customCycleUnit: null,
  category: "productivity",
  status: "active",
  paymentMethod: null,
  startDate: "2026-05-15",
  nextBillingDate: "2026-06-15",
  autoRenew: true,
  autoCalculateNextBillingDate: true,
  trialEndDate: null,
  website: null,
  notes: null,
  tags: [],
  reminderDays: 3,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  pinned: false,
  publicHidden: false,
};

const validSubscriptionResponseBody = {
  id: "sub_1",
  name: validSubscriptionCreateBody.name,
  price: validSubscriptionCreateBody.price,
  currency: validSubscriptionCreateBody.currency,
  billingCycle: validSubscriptionCreateBody.billingCycle,
  category: validSubscriptionCreateBody.category,
  status: validSubscriptionCreateBody.status,
  pinned: validSubscriptionCreateBody.pinned,
  publicHidden: validSubscriptionCreateBody.publicHidden,
  startDate: validSubscriptionCreateBody.startDate,
  nextBillingDate: validSubscriptionCreateBody.nextBillingDate,
  autoRenew: validSubscriptionCreateBody.autoRenew,
  autoCalculateNextBillingDate: validSubscriptionCreateBody.autoCalculateNextBillingDate,
  tags: validSubscriptionCreateBody.tags,
  reminderDays: validSubscriptionCreateBody.reminderDays,
  repeatReminderEnabled: validSubscriptionCreateBody.repeatReminderEnabled,
  repeatReminderInterval: validSubscriptionCreateBody.repeatReminderInterval,
  repeatReminderWindow: validSubscriptionCreateBody.repeatReminderWindow,
  extra: {},
};

const validSubscriptionCollectionBody = {
  id: validSubscriptionResponseBody.id,
  name: validSubscriptionResponseBody.name,
  price: validSubscriptionResponseBody.price,
  currency: validSubscriptionResponseBody.currency,
  billingCycle: validSubscriptionResponseBody.billingCycle,
  category: validSubscriptionResponseBody.category,
  status: validSubscriptionResponseBody.status,
  pinned: validSubscriptionResponseBody.pinned,
  publicHidden: validSubscriptionResponseBody.publicHidden,
  startDate: validSubscriptionResponseBody.startDate,
  nextBillingDate: validSubscriptionResponseBody.nextBillingDate,
  autoRenew: validSubscriptionResponseBody.autoRenew,
  autoCalculateNextBillingDate: validSubscriptionResponseBody.autoCalculateNextBillingDate,
  reminderDays: validSubscriptionResponseBody.reminderDays,
};

describe("subscription API schemas", () => {
  it("accepts private asset paths and http(s) URLs for subscription logos", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      logo: "/api/app/assets/2pbs0lgyypqhjoy",
    }).success).toBe(true);

    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      logo: "https://example.com/logo.png",
    }).success).toBe(true);

    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      logo: "http://example.com/logo.png",
    }).success).toBe(true);
  });

  it("keeps website URLs strict while rejecting unsupported logo references", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      website: "/api/app/assets/2pbs0lgyypqhjoy",
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      logo: "/other/assets/2pbs0lgyypqhjoy",
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      logo: "data:image/png;base64,aGVsbG8=",
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      logo: "javascript:alert(1)",
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      logo: "https://user:pass@example.com/logo.png",
    }).success).toBe(false);
  });

  it("accepts only supported repeat reminder presets", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      repeatReminderEnabled: true,
      repeatReminderInterval: "3h",
      repeatReminderWindow: "full",
    }).success).toBe(true);

    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      repeatReminderInterval: "2h",
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      repeatReminderWindow: "forever",
    }).success).toBe(false);
  });

  it("accepts disabled, inherited and explicit reminder day boundaries", () => {
    for (const reminderDays of [-2, -1, 0, 3, 3650]) {
      expect(subscriptionCreateBodySchema.safeParse({
        ...validSubscriptionCreateBody,
        reminderDays,
      }).success).toBe(true);

      expect(apiSubscriptionSchema.safeParse({
        ...validSubscriptionResponseBody,
        reminderDays,
      }).success).toBe(true);
    }

    for (const reminderDays of [-3, 3651]) {
      expect(subscriptionCreateBodySchema.safeParse({
        ...validSubscriptionCreateBody,
        reminderDays,
      }).success).toBe(false);
    }
  });

  it("allows nullable start dates only when no start-date anchor is required", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      startDate: null,
      autoCalculateNextBillingDate: false,
    }).success).toBe(true);

    expect(apiSubscriptionSchema.safeParse({
      ...validSubscriptionResponseBody,
      startDate: null,
      autoCalculateNextBillingDate: false,
    }).success).toBe(true);

    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      startDate: null,
      autoCalculateNextBillingDate: true,
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      billingCycle: "one-time",
      startDate: null,
      autoCalculateNextBillingDate: false,
    }).success).toBe(false);
  });

  it("rejects subscription response dates that are not date-only values", () => {
    expect(apiSubscriptionSchema.safeParse({
      ...validSubscriptionResponseBody,
      nextBillingDate: "2026-06-15T00:00:00Z",
    }).success).toBe(false);

    expect(apiSubscriptionSchema.safeParse({
      ...validSubscriptionResponseBody,
      trialEndDate: "06/15/2026",
    }).success).toBe(false);
  });

  it("accepts equal and custom cost sharing payloads", () => {
    const equalSharing = {
      enabled: true,
      splitMode: "equal",
      members: [
        { id: "partner", name: "Partner", note: "Transfers monthly", currency: "AUD" },
        { id: "child", name: "Child", note: "Transfers quarterly", currency: "CNY" },
      ],
    };
    const customSharing = {
      ...equalSharing,
      splitMode: "custom",
      members: [
        { id: "partner", name: "Partner", customAmount: "0.33" },
        { id: "child", name: "Child", customAmount: "0.5" },
      ],
    };

    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      costSharing: equalSharing,
    }).success).toBe(true);
    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      costSharing: customSharing,
    }).success).toBe(true);
    expect(apiSubscriptionSchema.safeParse({
      ...validSubscriptionResponseBody,
      costSharing: equalSharing,
    }).success).toBe(true);
    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      costSharing: {
        ...equalSharing,
        members: [{ id: "partner", name: "Partner", currency: "invalid" }],
      },
    }).success).toBe(false);
  });

  it("rejects invalid cost sharing members and custom amount shapes", () => {
    const baseSharing = {
      enabled: true,
      splitMode: "equal",
      members: [
        { id: "partner", name: "Partner" },
        { id: "child", name: "Child" },
      ],
    };

    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      costSharing: { ...baseSharing, payerMemberId: "partner" },
    }).success).toBe(false);
    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      costSharing: {
        ...baseSharing,
        members: [{ id: "partner", name: "Partner" }, { id: "partner", name: "Duplicate" }],
      },
    }).success).toBe(false);
    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      costSharing: {
        ...baseSharing,
        splitMode: "custom",
        members: [
          { id: "partner", name: "Partner" },
          { id: "child", name: "Child", customAmount: "0.1" },
        ],
      },
    }).success).toBe(false);
    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      costSharing: {
        ...baseSharing,
        splitMode: "custom",
        members: [
          { id: "partner", name: "Partner", customAmount: "0.1" },
          { id: "child", name: "Child", customAmount: "0.1" },
        ],
      },
    }).success).toBe(true);
  });

  it("accepts expired as a first-class subscription status", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      status: "expired",
    }).success).toBe(true);
  });

  it("defaults public visibility to shown unless the subscription opts out", () => {
    expect(subscriptionCreateBodySchema.parse({
      ...validSubscriptionCreateBody,
      publicHidden: undefined,
    }).publicHidden).toBe(false);

    expect(apiSubscriptionSchema.parse({
      ...validSubscriptionResponseBody,
      publicHidden: true,
    }).publicHidden).toBe(true);
  });

  it("defaults recurring writes to manual renewal while preserving response explicitness", () => {
    expect(subscriptionCreateBodySchema.parse({
      ...validSubscriptionCreateBody,
      autoRenew: undefined,
    }).autoRenew).toBe(false);

    expect(apiSubscriptionSchema.safeParse({
      ...validSubscriptionResponseBody,
      autoRenew: false,
    }).success).toBe(true);
  });

  it("keeps subscription response logos on the same persistent contract", () => {
    expect(apiSubscriptionSchema.safeParse({
      ...validSubscriptionResponseBody,
      logo: "http://example.com/logo.png",
    }).success).toBe(true);

    expect(apiSubscriptionSchema.safeParse({
      ...validSubscriptionResponseBody,
      logo: "data:image/png;base64,aGVsbG8=",
    }).success).toBe(false);
  });

  it("accepts one-time as a first-class billing cycle", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      billingCycle: "one-time",
      customDays: null,
      oneTimeTermCount: null,
      oneTimeTermUnit: null,
      autoRenew: false,
      autoCalculateNextBillingDate: false,
    }).success).toBe(true);
  });

  it("accepts one-time fixed terms only when count and unit are provided together", () => {
    expect(subscriptionCreateBodySchema.parse({
      ...validSubscriptionCreateBody,
      billingCycle: "one-time",
      customDays: null,
      customCycleUnit: null,
      oneTimeTermCount: 6,
      oneTimeTermUnit: "month",
      autoCalculateNextBillingDate: false,
    })).toMatchObject({
      billingCycle: "one-time",
      oneTimeTermCount: 6,
      oneTimeTermUnit: "month",
    });

    expect(apiSubscriptionSchema.safeParse({
      ...validSubscriptionResponseBody,
      billingCycle: "one-time",
      oneTimeTermCount: 2,
      oneTimeTermUnit: "year",
      autoRenew: false,
      autoCalculateNextBillingDate: false,
    }).success).toBe(true);

    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      billingCycle: "one-time",
      customDays: null,
      customCycleUnit: null,
      oneTimeTermCount: 6,
      autoCalculateNextBillingDate: false,
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      billingCycle: "one-time",
      customDays: null,
      customCycleUnit: null,
      oneTimeTermUnit: "month",
      autoCalculateNextBillingDate: false,
    }).success).toBe(false);
  });

  it("rejects one-time service terms on recurring subscriptions", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      oneTimeTermCount: 6,
      oneTimeTermUnit: "month",
    }).success).toBe(false);

    expect(apiSubscriptionSchema.safeParse({
      ...validSubscriptionResponseBody,
      oneTimeTermCount: 6,
      oneTimeTermUnit: "month",
    }).success).toBe(false);
  });

  it("accepts custom cycle units on custom subscriptions", () => {
    expect(subscriptionCreateBodySchema.parse({
      ...validSubscriptionCreateBody,
      billingCycle: "custom",
      customDays: 3,
      customCycleUnit: "year",
    })).toMatchObject({
      billingCycle: "custom",
      customDays: 3,
      customCycleUnit: "year",
    });

    expect(subscriptionCreateBodySchema.safeParse({
      ...validSubscriptionCreateBody,
      billingCycle: "custom",
      customDays: 3,
      customCycleUnit: "decade",
    }).success).toBe(false);

    expect(apiSubscriptionSchema.safeParse({
      ...validSubscriptionResponseBody,
      billingCycle: "custom",
      customDays: 2,
      customCycleUnit: "week",
    }).success).toBe(true);
  });

  it("requires paginated subscription list responses", () => {
    expect(subscriptionsListResponseSchema.safeParse(success({
      subscriptions: [validSubscriptionCollectionBody],
      nextCursor: null,
      total: 1,
    })).success).toBe(true);

    expect(subscriptionsListResponseSchema.safeParse({
      subscriptions: [validSubscriptionCollectionBody],
      nextCursor: null,
      total: 1,
    }).success).toBe(false);

    expect(subscriptionsListResponseSchema.safeParse(success({
      subscriptions: [validSubscriptionCollectionBody],
    })).success).toBe(false);
  });
});
