import { effectiveReminderDays } from "@renewlet/shared/runtime";
import { daysBetweenDateOnly, type DateOnly } from "@/lib/time/date-only";
import { isOneTimeBuyout } from "@/lib/subscription-billing";
import type { SubscriptionCollectionItem } from "@/types/subscription";
import { isEffectivelyActiveSubscription } from "./subscription-status";

export type UpcomingReminderKind = "renewal" | "expiry";

export interface UpcomingReminderItem {
  subscription: SubscriptionCollectionItem;
  kind: UpcomingReminderKind;
  daysUntil: number;
  reminderDays: number;
}

interface BuildUpcomingReminderItemsInput {
  subscriptions: readonly SubscriptionCollectionItem[];
  notificationReminderDays: number;
  today: DateOnly | string;
}

/** 构建首页“即将续费/到期”提醒窗口条目。 */
export function buildUpcomingReminderItems({
  subscriptions,
  notificationReminderDays,
  today,
}: BuildUpcomingReminderItemsInput): UpcomingReminderItem[] {
  const items: UpcomingReminderItem[] = [];

  for (const subscription of subscriptions) {
    if (!isEffectivelyActiveSubscription(subscription, today)) continue;
    if (isOneTimeBuyout(subscription)) continue;

    // 首页可视窗口复用 reminderDays 的哨兵契约，但这里只决定是否展示，不代表 Cron 发送时刻。
    const reminderDays = effectiveReminderDays(subscription.reminderDays, notificationReminderDays);
    if (reminderDays === undefined) continue;

    const daysUntil = daysBetweenDateOnly(today, subscription.nextBillingDate);
    if (daysUntil < 0 || daysUntil > reminderDays) continue;

    items.push({
      subscription,
      kind: subscription.billingCycle === "one-time" ? "expiry" : "renewal",
      daysUntil,
      reminderDays,
    });
  }

  return items.sort((a, b) => {
    if (a.daysUntil !== b.daysUntil) return a.daysUntil - b.daysUntil;
    return a.subscription.name.localeCompare(b.subscription.name);
  });
}
