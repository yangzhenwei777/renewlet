// 订阅克隆测试保护隐藏元数据边界，避免副本把导入幂等键带到新记录上。
import { describe, expect, it } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import type { Subscription, SubscriptionFormSubmission } from "@/types/subscription";
import { buildClonedSubscriptionDraft, cloneSubscriptionExtra } from "./subscription-clone";

const sourceSubscription: Subscription = {
  id: "sub-1",
  name: "Original SaaS",
  logo: "https://example.com/logo.svg",
  price: "29",
  currency: "USD",
  billingCycle: "monthly",
  category: "productivity",
  status: "active",
  paymentMethod: "credit_card",
  startDate: assertDateOnly("2026-05-14"),
  nextBillingDate: assertDateOnly("2026-06-14"),
  autoRenew: false,
  autoCalculateNextBillingDate: false,
  trialEndDate: undefined,
  website: "https://example.com",
  notes: "Team renewal",
  tags: ["team", "infra"],
  reminderDays: 3,
  repeatReminderEnabled: true,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  pinned: true,
  publicHidden: true,
  extra: {
    import: { source: "wallos", sourceId: "user:sub", confidence: "high" },
    wallos: { owner: "alice" },
  },
};

const submissionFromCloneForm: SubscriptionFormSubmission = {
  name: "Original SaaS",
  logo: "https://example.com/logo.svg",
  price: "29",
  currency: "USD",
  billingCycle: "monthly",
  category: "productivity",
  status: "active",
  paymentMethod: "credit_card",
  startDate: assertDateOnly("2026-05-14"),
  nextBillingDate: assertDateOnly("2026-06-14"),
  autoRenew: false,
  autoCalculateNextBillingDate: false,
  website: "https://example.com",
  notes: "Team renewal",
  tags: ["team", "infra"],
  reminderDays: 3,
  repeatReminderEnabled: true,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  publicHidden: false,
  costSharing: undefined,
};

describe("subscription clone", () => {
  it("removes import idempotency metadata without mutating the source extra", () => {
    const clonedExtra = cloneSubscriptionExtra(sourceSubscription.extra);

    expect(clonedExtra).toEqual({ wallos: { owner: "alice" } });
    expect(sourceSubscription.extra).toEqual({
      import: { source: "wallos", sourceId: "user:sub", confidence: "high" },
      wallos: { owner: "alice" },
    });
  });

  it("omits extra when import metadata was the only hidden state", () => {
    const clonedExtra = cloneSubscriptionExtra({
      import: { source: "wallos", sourceId: "user:sub", confidence: "high" },
    });

    expect(clonedExtra).toBeUndefined();
  });

  it("copies pinned state and non-import extra while keeping form-controlled public visibility", () => {
    const draft = buildClonedSubscriptionDraft(sourceSubscription, submissionFromCloneForm);

    expect(draft).toMatchObject({
      name: "Original SaaS",
      pinned: true,
      publicHidden: false,
      extra: { wallos: { owner: "alice" } },
    });
    expect(draft.extra).not.toHaveProperty("import");
  });
});
