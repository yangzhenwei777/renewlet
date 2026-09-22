import { describe, expect, it } from "vitest";
import type { AiRecognizedSubscriptionDraft } from "@/lib/api/schemas/ai-recognition";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import { DEFAULT_SETTINGS } from "@/types/subscription";
import { aiDraftToSubscriptionFormState, getInitialAIDraftConfirmationFields } from "./ai-recognition-form";

function draft(overrides: Partial<AiRecognizedSubscriptionDraft> = {}): AiRecognizedSubscriptionDraft {
  return {
    name: "DMIT",
    price: "15",
    currency: "CNY",
    billingCycle: "monthly",
    customDays: null,
    customCycleUnit: null,
    oneTimeTermCount: null,
    oneTimeTermUnit: null,
    category: "hosting_domains",
    status: "active",
    paymentMethod: "alipay",
    startDate: "2026-06-01",
    nextBillingDate: "2026-07-01",
    autoCalculateNextBillingDate: true,
    trialEndDate: null,
    website: { value: "https://www.dmit.io/", source: "suggested" },
    notes: { value: "DMIT 是提供 VPS、云服务器和网络线路服务的主机商。", source: "suggested" },
    tags: ["VPS", "Hosting"],
    reminderDays: null,
    repeatReminderEnabled: null,
    repeatReminderInterval: null,
    repeatReminderWindow: null,
    confidence: "high",
    warnings: [],
    ...overrides,
  };
}

const context = {
  config: DEFAULT_CUSTOM_CONFIG,
  settings: { ...DEFAULT_SETTINGS, defaultCurrency: "USD", notificationReminderDays: 5 },
};

describe("AI recognition form mapping", () => {
  it("initializes every visible subscription field in the editable form state", () => {
    const formData = aiDraftToSubscriptionFormState(draft({
      price: "12.5",
      currency: null,
      billingCycle: "custom",
      customDays: 45,
      customCycleUnit: "day",
      status: "trial",
      paymentMethod: "crypto",
      autoCalculateNextBillingDate: false,
      trialEndDate: "2026-06-15",
      reminderDays: 11,
      repeatReminderEnabled: true,
      repeatReminderInterval: "6h",
      repeatReminderWindow: "48h",
    }), context);

    expect(formData).toMatchObject({
      name: "DMIT",
      price: "12.5",
      currency: "USD",
      billingCycle: "custom",
      customDays: "45",
      customCycleUnit: "day",
      category: "hosting_domains",
      status: "trial",
      publicHidden: false,
      paymentMethod: "crypto",
      startDate: "2026-06-01",
      nextBillingDate: "2026-07-01",
      autoRenew: false,
      autoCalculate: false,
      reminderType: "custom",
      reminderDays: "5",
      customReminderDays: "11",
      repeatReminderEnabled: true,
      repeatReminderInterval: "6h",
      repeatReminderWindow: "48h",
      costSharing: undefined,
      website: "https://www.dmit.io/",
      notes: "DMIT 是提供 VPS、云服务器和网络线路服务的主机商。",
      tags: ["VPS", "Hosting"],
    });
  });

  it("keeps one-time normalization in the reusable form model", () => {
    const term = aiDraftToSubscriptionFormState(draft({
      billingCycle: "one-time",
      oneTimeTermCount: 2,
      oneTimeTermUnit: "year",
    }), context);
    const buyout = aiDraftToSubscriptionFormState(draft({
      billingCycle: "one-time",
      oneTimeTermCount: null,
      oneTimeTermUnit: null,
    }), context);

    expect(term).toMatchObject({ oneTimeMode: "term", oneTimeTermCount: "2", oneTimeTermUnit: "year", reminderType: "inherit" });
    expect(buyout).toMatchObject({ oneTimeMode: "buyout", reminderType: "disabled", reminderDays: "-2", repeatReminderEnabled: false });
  });

  it("tracks model defaults that still require explicit user confirmation", () => {
    expect(getInitialAIDraftConfirmationFields(draft())).toEqual([]);
    expect(getInitialAIDraftConfirmationFields(draft({
      price: null,
      currency: null,
      billingCycle: null,
    }))).toEqual(["price", "currency", "billingCycle"]);
  });
});
