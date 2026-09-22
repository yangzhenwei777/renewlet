// 调度 fixture 同时被 Go 读取；Worker 这里锁住本地窗口、跨日和 repeat due 的同一组期望。
import { describe, expect, it, vi } from "vitest";
import { notificationScheduleFixtures, type NotificationScheduleFixture } from "@renewlet/shared/contract-fixtures";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { apiSubscriptionSchema, type ApiSubscription } from "@renewlet/shared/schemas/subscriptions";
import { collectNotificationItemsForSchedule } from "./notifications";
import { getNotificationScheduleDecision } from "./notification-schedule";

vi.mock("./smtp", () => ({
  notificationSmtpConfig: () => {
    throw new Error("SMTP should not be used by notification schedule tests");
  },
  sendSmtpEmail: async () => undefined,
}));

function settings(fixture: NotificationScheduleFixture): ApiAppSettings {
  return {
    ...createDefaultAppSettings(),
    timezone: fixture.settings.timezone,
    notificationTimeLocal: fixture.settings.notificationTimeLocal as ApiAppSettings["notificationTimeLocal"],
    notificationReminderDays: fixture.settings.notificationReminderDays,
  };
}

function subscription(input: NotificationScheduleFixture["subscriptions"][number]): ApiSubscription {
  return apiSubscriptionSchema.parse({
    id: input.id,
    name: input.name,
    price: input.price,
    currency: input.currency,
    billingCycle: input.billingCycle,
    ...(input.oneTimeTermCount ? { oneTimeTermCount: input.oneTimeTermCount, oneTimeTermUnit: input.oneTimeTermUnit } : {}),
    category: "productivity",
    status: input.status,
    pinned: false,
    publicHidden: false,
    startDate: "2026-01-01",
    nextBillingDate: input.nextBillingDate,
    autoRenew: input.billingCycle === "one-time" ? false : true,
    autoCalculateNextBillingDate: true,
    ...(input.trialEndDate ? { trialEndDate: input.trialEndDate } : {}),
    tags: [],
    reminderDays: input.reminderDays,
    repeatReminderEnabled: input.repeatReminderEnabled,
    repeatReminderInterval: input.repeatReminderInterval,
    repeatReminderWindow: input.repeatReminderWindow,
    extra: {},
  });
}

describe("Cloudflare notification schedule", () => {
  it.each(notificationScheduleFixtures)("matches shared fixture $name", (fixture) => {
    const appSettings = settings(fixture);
    const subscriptions = fixture.subscriptions.map(subscription);
    const decision = getNotificationScheduleDecision(new Date(fixture.nowUtc), appSettings, subscriptions, fixture.windowMinutes, fixture.force);

    expect(decision.due).toBe(fixture.expected.due);
    if (fixture.expected.due) {
      expect(decision.reason).toBe(fixture.expected.reason);
      expect(decision).toMatchObject({
        scheduledLocalDate: fixture.expected.scheduledLocalDate,
        scheduledLocalTime: fixture.expected.scheduledLocalTime,
        timeZone: fixture.expected.timeZone,
        scheduledInstantUtc: fixture.expected.scheduledInstantUtc,
      });
      const items = collectNotificationItemsForSchedule(decision, appSettings, subscriptions, { includeExpired: true });
      expect(items.map((item) => item.type)).toEqual(fixture.expected.itemTypes);
      if (fixture.expected.repeatReminder) {
        expect(items[0]?.repeatReminder).toEqual(fixture.expected.repeatReminder);
      }
    }
  });
});
