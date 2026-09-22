// Public API schema 测试固定只读 token 和响应 DTO 契约，避免 Docker/Worker/前端各自扩展出第二套形状。
import { describe, expect, it } from "vitest";
import {
  apiTokenCreateResponseSchema,
  apiTokenSchema,
  apiTokensListResponseSchema,
  publicApiDueResponseSchema,
  publicApiMeResponseSchema,
  publicApiStatusResponseSchema,
  publicApiSubscriptionResponseSchema,
  publicApiSubscriptionsListResponseSchema,
  publicApiTokenPlainSchema,
} from "./public-api";

const PLAIN_TOKEN = "rlt_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12";

const success = <T>(data: T) => ({ ok: true, data });

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_public_api",
    name: "Public API Plan",
    price: "12",
    currency: "USD",
    billingCycle: "monthly",
    category: "developer_tools",
    status: "active",
    pinned: false,
    publicHidden: false,
    startDate: "2026-06-01",
    nextBillingDate: "2026-07-01",
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    tags: ["api"],
    reminderDays: 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: { source: "test" },
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("public API schemas", () => {
  it("accepts only Renewlet public API token shape for one-time plain tokens", () => {
    expect(publicApiTokenPlainSchema.parse(PLAIN_TOKEN)).toBe(PLAIN_TOKEN);
    expect(publicApiTokenPlainSchema.safeParse("session-token").success).toBe(false);
    expect(publicApiTokenPlainSchema.safeParse("Bearer " + PLAIN_TOKEN).success).toBe(false);
    expect(publicApiTokenPlainSchema.safeParse("rlt_short").success).toBe(false);
  });

  it("keeps management list items metadata-only while create returns plainToken once", () => {
    const token = {
      id: "tok_public_api",
      name: "Telegram Bot",
      tokenPrefix: PLAIN_TOKEN.slice(0, 12),
      scopes: ["read"],
      createdAt: "2026-06-20T00:00:00.000Z",
      lastUsedAt: null,
    };

    expect(apiTokenSchema.parse(token)).toMatchObject({ scopes: ["read"] });
    expect(apiTokenSchema.safeParse({ ...token, plainToken: PLAIN_TOKEN }).success).toBe(false);
    expect(apiTokenSchema.safeParse({ ...token, revokedAt: "2026-06-20T00:00:00.000Z" }).success).toBe(false);
    expect(apiTokensListResponseSchema.safeParse(success({ tokens: [{ ...token, plainToken: PLAIN_TOKEN }] })).success).toBe(false);
    expect(apiTokensListResponseSchema.safeParse({ tokens: [] }).success).toBe(false);
    expect(apiTokenCreateResponseSchema.parse(success({ token, plainToken: PLAIN_TOKEN })).data.plainToken).toBe(PLAIN_TOKEN);
  });

  it("parses public read responses for me, status and due items", () => {
    expect(publicApiMeResponseSchema.parse(success({ scopes: ["read"] })).data).toEqual({ scopes: ["read"] });
    expect(publicApiMeResponseSchema.safeParse(success({ ok: true, scopes: ["read"] })).success).toBe(false);
    expect(publicApiStatusResponseSchema.parse(success({
      generatedAt: "2026-06-20T00:00:00.000Z",
      total: 1,
      byStatus: {
        active: 1,
        trial: 0,
        expired: 0,
        paused: 0,
        cancelled: 0,
      },
    })).data.total).toBe(1);
    expect(publicApiDueResponseSchema.parse(success({
      days: 30,
      generatedAt: "2026-06-20T00:00:00.000Z",
      items: [{
        dueDate: "2026-07-01",
        dueType: "renewal",
        subscription: subscription({ startDate: null, autoCalculateNextBillingDate: false }),
      }],
    })).data.items[0]?.subscription.startDate).toBeNull();
  });

  it("keeps the published subscription DTO independent from the private collection contract", () => {
    const { tags: _tags, extra: _extra, ...publishedShape } = subscription();

    expect(publicApiSubscriptionsListResponseSchema.parse(success({
      subscriptions: [publishedShape],
      nextCursor: null,
    })).data.subscriptions).toHaveLength(1);
    expect(publicApiSubscriptionResponseSchema.parse(success({
      subscription: publishedShape,
    })).data.subscription.id).toBe("sub_public_api");
  });

  it("keeps the published optional billing fields while preserving existing one-time validation", () => {
    expect(publicApiSubscriptionResponseSchema.safeParse(success({
      subscription: subscription({ billingCycle: "custom" }),
    })).success).toBe(true);
    expect(publicApiSubscriptionResponseSchema.safeParse(success({
      subscription: subscription({ billingCycle: "monthly", customDays: 3, customCycleUnit: "month" }),
    })).success).toBe(true);
    expect(publicApiSubscriptionResponseSchema.safeParse(success({
      subscription: subscription({ billingCycle: "one-time" }),
    })).success).toBe(true);
    expect(publicApiSubscriptionResponseSchema.safeParse(success({
      subscription: subscription({ billingCycle: "one-time", oneTimeTermCount: 6, oneTimeTermUnit: "month" }),
    })).success).toBe(true);
    expect(publicApiSubscriptionResponseSchema.safeParse(success({
      subscription: subscription({ billingCycle: "one-time", oneTimeTermCount: 6 }),
    })).success).toBe(false);
    expect(publicApiSubscriptionResponseSchema.safeParse(success({
      subscription: subscription({ billingCycle: "one-time", oneTimeTermUnit: "month" }),
    })).success).toBe(false);
  });
});
