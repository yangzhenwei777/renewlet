// 日历事件 mapper 必须保持纯计算，避免浏览器端在线日历链接重新依赖 ICS 序列化库。
import { describe, expect, it, vi } from "vitest";
import { buildRenewalCalendarEvent } from "./calendar-events";

describe("buildRenewalCalendarEvent", () => {
  it("builds stable renewal event metadata without serializer dependencies", () => {
    const event = buildRenewalCalendarEvent({
      subscription: {
        id: "sub_1",
        name: "Fastmail",
        price: "5",
        currency: "USD",
        billingCycle: "monthly",
        category: "Productivity",
        paymentMethod: "Visa",
        nextBillingDate: "2026-06-02",
        website: "https://fastmail.example",
        notes: "Team plan",
      },
      labels: {
        amount: "$5.00",
        billingCycle: "Monthly",
        category: "Productivity",
        paymentMethod: "Visa",
      },
      reminderDays: 3,
      text: {
        amount: ({ amount }) => `Amount: ${amount}`,
        billingCycle: (cycle) => `Billing cycle: ${cycle}`,
        category: (category) => `Category: ${category}`,
        paymentMethod: (paymentMethod) => `Payment method: ${paymentMethod}`,
        notes: (notes) => `Notes: ${notes}`,
      },
    });

    expect(event).toEqual({
      uid: "renewlet-renewal-sub_1@renewlet",
      kind: "renewal",
      date: "2026-06-02",
      summary: "Fastmail",
      description: "Amount: $5.00\nBilling cycle: Monthly\nCategory: Productivity\nPayment method: Visa\nNotes: Team plan",
      categories: "Productivity",
      url: "https://fastmail.example",
      reminderDays: 3,
    });
  });

  it("does not import the ICS serializer", async () => {
    vi.resetModules();
    vi.doMock("ical-generator", () => {
      throw new Error("calendar event mapper must not import the ICS serializer");
    });
    try {
      const module = await import("./calendar-events");
      expect(module.buildRenewalCalendarEvent).toBeTypeOf("function");
    } finally {
      vi.doUnmock("ical-generator");
    }
  });
});
