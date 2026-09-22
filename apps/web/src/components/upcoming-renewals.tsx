/**
 * 即将续费/到期列表（侧边栏卡片）。
 *
 * 规则：
 * - 只展示提醒窗口内的 active/trial
 * - 展示续费或一次性固定服务期到期
 * - 最多展示 5 条
 */

import type { SubscriptionCollectionItem } from '@/types/subscription';
import { cn } from '@/lib/utils';
import { formatDateOnlyMonthDay, type DateOnly } from '@/lib/time/date-only';
import { useI18n } from '@/i18n/I18nProvider';
import { buildUpcomingReminderItems } from '@/modules/subscriptions/domain/upcoming-reminders';

interface UpcomingRenewalsProps {
  /** 订阅列表（前端 domain 类型）。 */
  subscriptions: SubscriptionCollectionItem[];
  /** Dashboard 页面级账号业务日期。 */
  today: DateOnly | string;
  /** 设置页默认提前提醒天数，用于解析继承型订阅。 */
  notificationReminderDays: number;
}

/** 即将续费列表组件。 */
export function UpcomingRenewals({ subscriptions, today, notificationReminderDays }: UpcomingRenewalsProps) {
  const { t, formatCurrency, locale } = useI18n();
  const upcoming = buildUpcomingReminderItems({ subscriptions, today, notificationReminderDays }).slice(0, 5);

  if (upcoming.length === 0) {
    return (
      <p className="py-4 text-center text-sm leading-6 text-muted-foreground">{t("upcoming.noneNextTwoWeeks")}</p>
    );
  }

  return (
    <div className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)_max-content] gap-3">
      {upcoming.map((item) => (
        <div
          key={item.subscription.id}
          className={cn(
            "col-span-3 grid min-w-0 grid-cols-subgrid items-center rounded-lg border border-border bg-secondary/50 p-4 transition-colors hover:bg-secondary",
            item.daysUntil <= 3 && "border-warning/30 bg-warning/5"
          )}
        >
          <div className={cn(
            "flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold",
            item.daysUntil <= 3
              ? "bg-warning/20 text-warning"
              : "bg-muted text-muted-foreground"
          )}>
            {item.daysUntil === 0 ? t("upcoming.todayShort") : t("upcoming.daysShort", { days: item.daysUntil })}
          </div>
          <div className="min-w-0">
            <p className="min-w-0 wrap-break-word font-medium text-foreground">{item.subscription.name}</p>
            <p className="text-xs text-muted-foreground">
              {item.kind === "expiry"
                ? t("upcoming.expiresOn", { date: formatDateOnlyMonthDay(item.subscription.nextBillingDate, locale) })
                : t("upcoming.renewsOn", { date: formatDateOnlyMonthDay(item.subscription.nextBillingDate, locale) })}
            </p>
          </div>
          <p className="whitespace-nowrap text-right font-semibold tabular-nums text-foreground">
            {formatCurrency(item.subscription.price, item.subscription.currency)}
          </p>
        </div>
      ))}
    </div>
  );
}
