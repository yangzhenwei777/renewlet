// 订阅状态测试保护 expired 正式语义和旧 active/trial 读取侧转换，避免业务页面各自判断过期。
import { describe, expect, it } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import type { Subscription } from "@/types/subscription";
import { getEffectiveSubscriptionStatus } from "./subscription-status";

function subscription(overrides: Partial<Pick<Subscription, "status" | "nextBillingDate">>) {
  return {
    status: "active",
    nextBillingDate: assertDateOnly("2026-05-15"),
    ...overrides,
  } satisfies Pick<Subscription, "status" | "nextBillingDate">;
}

describe("effective subscription status", () => {
  it("treats overdue active and trial subscriptions as expired without changing stored status", () => {
    const today = assertDateOnly("2026-05-18");

    expect(getEffectiveSubscriptionStatus(subscription({ status: "active" }), today)).toBe("expired");
    expect(getEffectiveSubscriptionStatus(subscription({ status: "trial" }), today)).toBe("expired");
  });

  it("keeps explicit inactive statuses from being overwritten by date compatibility", () => {
    const today = assertDateOnly("2026-05-18");

    expect(getEffectiveSubscriptionStatus(subscription({ status: "paused" }), today)).toBe("paused");
    expect(getEffectiveSubscriptionStatus(subscription({ status: "cancelled" }), today)).toBe("cancelled");
  });

  it("respects stored expired status even if the billing date is not in the past", () => {
    expect(getEffectiveSubscriptionStatus(
      subscription({ status: "expired", nextBillingDate: assertDateOnly("2026-05-20") }),
      assertDateOnly("2026-05-18"),
    )).toBe("expired");
  });
});
