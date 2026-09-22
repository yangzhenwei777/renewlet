import { endOfMonth, endOfWeek, startOfMonth, startOfWeek } from "date-fns";
import { dateToDateOnly, type DateOnly } from "@/lib/time/date-only";

export interface SubscriptionCalendarRange {
  from: DateOnly;
  to: DateOnly;
}

/** API 范围必须覆盖月视图两端的补齐周，避免边缘日期在 UI 可见却没有数据。 */
export function getSubscriptionCalendarRange(month: Date): SubscriptionCalendarRange {
  const from = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const to = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
  return { from: dateToDateOnly(from), to: dateToDateOnly(to) };
}
