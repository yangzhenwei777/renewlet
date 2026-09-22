// 通知内容测试保护前端预览与服务端通知语义一致，尤其是本地时间、重复提醒和空内容展示。
import { describe, expect, it } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import { DEFAULT_SETTINGS } from "@/types/subscription";
import {
  buildDueNotification,
  buildTestNotification,
  formatNotificationDisplayTime,
  getTodayDateOnlyInTimeZone,
} from "./notification-content";

describe("notification-content", () => {
  it("falls back to UTC when timezone is invalid", () => {
    const now = new Date("2026-01-01T23:30:00.000Z");

    expect(getTodayDateOnlyInTimeZone(now, "Not/A_Zone")).toBe("2026-01-01");
  });

  it("formats notification display time with the selected IANA timezone", () => {
    const now = new Date("2026-05-14T02:51:25.599Z");

    expect(formatNotificationDisplayTime(now, "Asia/Shanghai")).toBe("2026-05-14 10:51:25 Asia/Shanghai");
    expect(formatNotificationDisplayTime(now, "America/New_York")).toBe("2026-05-13 22:51:25 America/New_York");
    expect(formatNotificationDisplayTime(now, "Europe/London")).toBe("2026-05-14 03:51:25 Europe/London");
    expect(formatNotificationDisplayTime(now, "Not/A_Zone")).toBe("2026-05-14 02:51:25 UTC");
  });

  it("uses localized display time for test notifications", () => {
    const content = buildTestNotification(new Date("2026-05-14T02:51:25.599Z"), "Asia/Shanghai");

    expect(content.timestamp).toBe("2026-05-14 10:51:25 Asia/Shanghai");
    expect(content.timestamp).not.toContain("T02:51:25.599Z");
  });

  it("builds renewal and trial reminders exactly on reminder day", () => {
    const content = buildDueNotification(
      new Date("2026-01-10T00:00:00.000Z"),
      { ...DEFAULT_SETTINGS, timezone: "UTC", showExpired: false },
      [
        {
          id: "sub-1",
          name: "Netflix",
          price: "10",
          currency: "USD",
          status: "active",
          nextBillingDate: "2026-01-13",
          reminderDays: 3,
        },
        {
          id: "sub-2",
          name: "Trial",
          price: "0",
          currency: "USD",
          status: "trial",
          nextBillingDate: "2026-02-01",
          trialEndDate: "2026-01-13",
          reminderDays: 3,
        },
      ],
    );

    expect(content.hasPayload).toBe(true);
    expect(content.items).toEqual([
      expect.objectContaining({
        subscriptionId: "sub-1",
        type: "renewal",
        targetDate: "2026-01-13",
        reminderDays: 3,
      }),
      expect.objectContaining({
        subscriptionId: "sub-2",
        type: "trial",
        targetDate: "2026-01-13",
        reminderDays: 3,
      }),
    ]);
    expect(content.content).toContain("即将续费");
    expect(content.content).toContain("试用结束");
  });

  it("uses global reminder days for inherited subscription reminders", () => {
    const content = buildDueNotification(
      new Date("2026-01-10T00:00:00.000Z"),
      { ...DEFAULT_SETTINGS, timezone: "UTC", notificationReminderDays: 5, showExpired: false },
      [
        {
          id: "sub-inherit",
          name: "Inherited SaaS",
          price: "10",
          currency: "USD",
          status: "active",
          nextBillingDate: "2026-01-15",
          reminderDays: -1,
        },
      ],
    );

    expect(content.hasPayload).toBe(true);
    expect(content.items).toEqual([
      expect.objectContaining({
        subscriptionId: "sub-inherit",
        type: "renewal",
        targetDate: "2026-01-15",
        reminderDays: 5,
      }),
    ]);
    expect(content.items[0]?.reminderDays).not.toBe(-1);
  });

  it("skips subscriptions with disabled reminders", () => {
    const content = buildDueNotification(
      new Date("2026-01-10T00:00:00.000Z"),
      { ...DEFAULT_SETTINGS, timezone: "UTC", showExpired: false },
      [
        {
          id: "sub-quiet",
          name: "Quiet SaaS",
          price: "10",
          currency: "USD",
          status: "active",
          nextBillingDate: "2026-01-10",
          reminderDays: -2,
        },
      ],
    );

    expect(content.hasPayload).toBe(false);
    expect(content.items).toEqual([]);
  });

  it("builds English notification content when the account preference is English", () => {
    const content = buildDueNotification(
      new Date("2026-01-10T00:00:00.000Z"),
      { ...DEFAULT_SETTINGS, localePreference: "en-US", timezone: "UTC", showExpired: false },
      [
        {
          id: "sub-1",
          name: "Netflix",
          price: "10",
          currency: "USD",
          status: "active",
          nextBillingDate: "2026-01-13",
          reminderDays: 3,
        },
      ],
    );

    expect(content.title).toBe("Renewlet subscription reminder");
    expect(content.content).toContain("Upcoming renewals");
    expect(content.content).toContain("3 days before");
  });

  it("skips invalid dirty date rows instead of crashing notification generation", () => {
    const content = buildDueNotification(
      new Date("2026-01-10T00:00:00.000Z"),
      { ...DEFAULT_SETTINGS, timezone: "UTC", showExpired: true },
      [
        {
          id: "bad",
          name: "Broken",
          price: "10",
          currency: "USD",
          status: "active",
          nextBillingDate: "2026-02-31",
          reminderDays: 3,
        },
      ],
    );

    expect(content.hasPayload).toBe(false);
    expect(content.items).toEqual([]);
    expect(content.content).toContain("今天没有需要提醒");
  });

  it("includes expired subscriptions only when showExpired is enabled", () => {
    const subscription = {
      id: "expired",
      name: "Old service",
      price: "5",
      currency: "USD",
      status: "active" as const,
      nextBillingDate: "2026-01-01",
      reminderDays: 3,
    };

    expect(buildDueNotification(
      new Date("2026-01-10T00:00:00.000Z"),
      { ...DEFAULT_SETTINGS, timezone: "UTC", showExpired: false },
      [subscription],
    ).hasPayload).toBe(false);

    const enabledContent = buildDueNotification(
      new Date("2026-01-10T00:00:00.000Z"),
      { ...DEFAULT_SETTINGS, timezone: "UTC", showExpired: true },
      [subscription],
    );

    expect(enabledContent.content).toContain("已过期");
    expect(enabledContent.items).toHaveLength(1);
    expect(enabledContent.items[0]).toMatchObject({ type: "expired", subscriptionId: "expired" });
  });

  it("builds expiry reminders for one-time fixed terms", () => {
    const content = buildDueNotification(
      new Date("2026-01-10T00:00:00.000Z"),
      { ...DEFAULT_SETTINGS, timezone: "UTC", showExpired: false },
      [
        {
          id: "fixed-term",
          name: "Discounted membership",
          price: "120",
          currency: "USD",
          status: "active",
          billingCycle: "one-time",
          oneTimeTermCount: 6,
          oneTimeTermUnit: "month",
          nextBillingDate: "2026-01-13",
          reminderDays: 3,
        },
      ],
    );

    expect(content.hasPayload).toBe(true);
    expect(content.items).toEqual([
      expect.objectContaining({
        subscriptionId: "fixed-term",
        type: "expiry",
        targetDate: "2026-01-13",
        reminderDays: 3,
      }),
    ]);
    expect(content.content).toContain("即将到期");
    expect(content.content).not.toContain("即将续费");
  });

  it("skips one-time buyouts instead of treating purchase date as a reminder boundary", () => {
    const content = buildDueNotification(
      new Date("2026-01-10T00:00:00.000Z"),
      { ...DEFAULT_SETTINGS, timezone: "UTC", showExpired: true },
      [
        {
          id: "buyout",
          name: "Lifetime license",
          price: "199",
          currency: "USD",
          status: "active",
          billingCycle: "one-time",
          nextBillingDate: "2026-01-07",
          reminderDays: 3,
        },
      ],
    );

    expect(content.hasPayload).toBe(false);
    expect(content.items).toEqual([]);
  });

  it("moves expired one-time fixed terms into the expired group when enabled", () => {
    const content = buildDueNotification(
      new Date("2026-01-10T00:00:00.000Z"),
      { ...DEFAULT_SETTINGS, timezone: "UTC", showExpired: true },
      [
        {
          id: "expired-fixed-term",
          name: "Expired membership",
          price: "120",
          currency: "USD",
          status: "active",
          billingCycle: "one-time",
          oneTimeTermCount: 6,
          oneTimeTermUnit: "month",
          nextBillingDate: "2026-01-01",
          reminderDays: 3,
        },
      ],
    );

    expect(content.items).toEqual([
      expect.objectContaining({ type: "expired", subscriptionId: "expired-fixed-term" }),
    ]);
    expect(content.content).toContain("已过期");
  });

  it("builds cost sharing collection reminders from member joined dates", () => {
    const content = buildDueNotification(
      new Date("2026-01-07T00:00:00.000Z"),
      { ...DEFAULT_SETTINGS, timezone: "UTC", showExpired: false },
      [
        {
          id: "family",
          name: "Family Plan",
          price: "30",
          currency: "USD",
          status: "active",
          billingCycle: "monthly",
          startDate: null,
          nextBillingDate: "2026-12-31",
          reminderDays: -2,
          costSharing: {
            enabled: true,
            splitMode: "equal",
            collectionReminder: { enabled: true, reminderDays: 3 },
            members: [
              { id: "partner", name: "Partner", joinedDate: assertDateOnly("2025-12-10"), currency: "USD" },
              { id: "friend", name: "Friend", joinedDate: assertDateOnly("2025-12-11"), currency: "USD" },
            ],
          },
        },
      ],
    );

    expect(content.items).toEqual([
      expect.objectContaining({
        type: "costSharing",
        subscriptionId: "family",
        targetDate: "2026-01-10",
        reminderDays: 3,
        costSharing: { memberName: "Partner", amount: "10", currency: "USD" },
      }),
    ]);
    expect(content.content).toContain("家庭共享收款");
    expect(content.content).toContain("Partner");
  });

  it("skips cost sharing collection reminders for one-time buyouts", () => {
    const content = buildDueNotification(
      new Date("2026-01-07T00:00:00.000Z"),
      { ...DEFAULT_SETTINGS, timezone: "UTC", showExpired: false },
      [
        {
          id: "buyout-family",
          name: "Lifetime Family",
          price: "30",
          currency: "USD",
          status: "active",
          billingCycle: "one-time",
          startDate: "2025-12-10",
          nextBillingDate: "2026-01-10",
          reminderDays: -2,
          costSharing: {
            enabled: true,
            splitMode: "equal",
            collectionReminder: { enabled: true, reminderDays: 3 },
            members: [{ id: "partner", name: "Partner", joinedDate: assertDateOnly("2025-12-10"), currency: "USD" }],
          },
        },
      ],
    );

    expect(content.hasPayload).toBe(false);
    expect(content.items).toEqual([]);
  });
});
