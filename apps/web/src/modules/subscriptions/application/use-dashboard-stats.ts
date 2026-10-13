import type { SubscriptionCollectionItem } from "@/types/subscription";
import type { DateOnly } from "@/lib/time/date-only";
import { buildDashboardStats } from "../domain/dashboard-stats";

export function useDashboardStats(
  subscriptions: readonly SubscriptionCollectionItem[],
  defaultCurrency: string,
  convert: (amount: number | string, from: string, to: string) => number,
  today: DateOnly | string,
  notificationReminderDays: number,
) {
  "use memo";
  return buildDashboardStats({ subscriptions, defaultCurrency, convert, today, notificationReminderDays });
}
