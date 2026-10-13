// 续订算法测试读取共享 JSON fixture；同一批样例也由 Go 后端读取，用来锁住跨运行面账单日推进语义。
import { describe, expect, it } from "vitest";
import fixtures from "./subscription-renewal-fixtures.json";
import {
  advanceSubscriptionRenewal,
  calculateNextBillingDate,
  isAutoRenewEligible,
  isManualRenewEligible,
  type RenewalMode,
  type SubscriptionRenewalInput,
} from "./subscription-renewal";

type Fixture = {
  name: string;
  input: SubscriptionRenewalInput;
  today: string;
  mode: RenewalMode;
  eligible: boolean;
  expectedNextBillingDate?: string;
  expectedStatus?: string;
};

describe("subscription renewal", () => {
  it("retains the historical calendar advance bound after jumping directly to the due cycle", () => {
    expect(() => calculateNextBillingDate("0001-01-31", "monthly", undefined, "1667-10-01"))
      .toThrow("SUBSCRIPTION_RENEWAL_ADVANCE_LIMIT_EXCEEDED");
    expect(calculateNextBillingDate("0001-01-31", "custom", 1, "2026-10-09", "day"))
      .toBe("2026-10-09");
  });

  // 这份 fixture 同时被 Go 后端读取；新增续订规则时先扩展 fixture，再让两端实现追同一组期望。
  it.each(fixtures as Fixture[])("matches fixture $name", (fixture) => {
    const eligible = fixture.mode === "auto"
      ? isAutoRenewEligible(fixture.input, fixture.today)
      : isManualRenewEligible(fixture.input);
    expect(eligible).toBe(fixture.eligible);

    const result = advanceSubscriptionRenewal(fixture.input, fixture.today, fixture.mode);
    if (!fixture.eligible) {
      expect(result).toBeNull();
      return;
    }
    expect(result).toEqual({
      nextBillingDate: fixture.expectedNextBillingDate,
      status: fixture.expectedStatus,
    });
  });
});
