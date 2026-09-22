/**
 * 续费/到期日历弹窗组合。
 *
 * 架构位置：SubscriptionCalendar 负责日期网格和事件聚合，本文件只展示选中日期列表；
 * 订阅详情复用通用 SubscriptionDetailDialog。
 *
 * 注意： 弹窗中的金额、周期和状态标签必须继续复用 subscription domain 常量，避免日历视图口径分叉。
 */
import type { SubscriptionCollectionItem } from '@/types/subscription';
import { Button } from '@/components/ui/button';
import { CalendarDays } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileBottomDrawerContent, MobileDrawerRoot } from '@/components/ui/mobile-drawer';
import { TruncatedTooltipText } from '@/components/ui/truncated-tooltip-text';
import { useCustomConfigState } from '@/contexts/CustomConfigContext';
import { useI18n } from '@/i18n/I18nProvider';
import type { DateOnly } from '@/lib/time/date-only';
import { getEffectiveSubscriptionStatus } from '@/modules/subscriptions/domain/subscription-status';
import { SubscriptionLogo } from '@/components/subscription-logo';
import { formatBillingCycleLabel } from '@/lib/subscription-billing';
import { SubscriptionStatusBadge } from '@/components/subscription-status-badge';

const DEFAULT_LOGO_FALLBACK_COLOR = "hsl(var(--primary))";

interface CalendarSubscriptionLogoProps {
  subscription: SubscriptionCollectionItem;
  categoryColor: string | undefined;
  className?: string | undefined;
}

function CalendarSubscriptionLogo({ subscription, categoryColor, className }: CalendarSubscriptionLogoProps) {
  return <SubscriptionLogo name={subscription.name} logo={subscription.logo} fallbackColor={categoryColor ?? DEFAULT_LOGO_FALLBACK_COLOR} size="sm" className={className} />;
}

export interface CalendarDaySubscriptions {
  date: Date;
  subscriptions: SubscriptionCollectionItem[];
}

export interface DaySubscriptionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDaySubs: CalendarDaySubscriptions | null;
  onSelectSubscription: (subscription: SubscriptionCollectionItem) => void;
  onPrefetchSubscription: (id: string) => void;
  today: DateOnly | string;
  isMobile?: boolean | undefined;
}

interface DaySubscriptionsListProps {
  subscriptions: SubscriptionCollectionItem[];
  onSelectSubscription: (subscription: SubscriptionCollectionItem) => void;
  onPrefetchSubscription: (id: string) => void;
  today: DateOnly | string;
}

function DaySubscriptionsList({ subscriptions, onSelectSubscription, onPrefetchSubscription, today }: DaySubscriptionsListProps) {
  const { config } = useCustomConfigState();
  const { locale, formatCurrency } = useI18n();

  return (
    <div className="grid min-w-0 max-w-full grid-cols-1 gap-2" data-testid="calendar-day-subscription-list">
      {subscriptions.map((sub) => {
        // 当天列表和详情弹窗保持同一口径，确保旧过期数据不会在同一个日历流程里显示成不同状态。
        const effectiveStatus = getEffectiveSubscriptionStatus(sub, today);

        return (
          <button
            key={sub.id}
            type="button"
            onClick={() => onSelectSubscription(sub)}
            onPointerEnter={() => onPrefetchSubscription(sub.id)}
            onFocus={() => onPrefetchSubscription(sub.id)}
            className="group flex min-w-0 w-full max-w-full items-center gap-3 rounded-lg border border-border bg-secondary/30 p-3 text-left transition-colors hover:bg-secondary/60"
            data-testid="calendar-day-subscription-item"
          >
            <CalendarSubscriptionLogo
              subscription={sub}
              categoryColor={
                config.categories.find((item) => item.value === sub.category)?.color ??
                DEFAULT_LOGO_FALLBACK_COLOR
              }
            />
            <div className="min-w-0 flex-1">
              <TruncatedTooltipText as="p" text={sub.name} className="text-sm font-medium" />
              <p className="text-xs text-muted-foreground">
                {formatBillingCycleLabel(sub, locale)}
              </p>
            </div>
            <div className="min-w-0 max-w-[42%] shrink-0 text-right">
              <p className="truncate font-semibold text-foreground">
                {formatCurrency(sub.price, sub.currency)}
              </p>
              <SubscriptionStatusBadge status={effectiveStatus} className="max-w-full truncate" />
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function DaySubscriptionsDialog({
  open,
  onOpenChange,
  selectedDaySubs,
  onSelectSubscription,
  onPrefetchSubscription,
  today,
  isMobile = false,
}: DaySubscriptionsDialogProps) {
  const { t, formatDateTime } = useI18n();
  const selectedDayLabel = selectedDaySubs
    ? formatDateTime(selectedDaySubs.date, { month: "short", day: "numeric" })
    : "";

  if (isMobile) {
    // 移动端当天列表使用 Drawer，避免小屏上 Dialog 高度和日历网格滚动互相挤压。
    return (
      <MobileDrawerRoot open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
        {open && (
          <MobileBottomDrawerContent
            title={selectedDaySubs
              ? t("calendar.dayRenewals", { date: selectedDayLabel })
              : t("calendar.dayListFallbackDescription")}
            description={selectedDaySubs
              ? t("calendar.dayListDescription", { date: selectedDayLabel })
              : t("calendar.dayListFallbackDescription")}
            descriptionMode="sr-only"
            closeLabel={t("common.close")}
            icon={<CalendarDays className="h-5 w-5 shrink-0 text-primary" />}
            className="min-h-[42dvh]"
          >
              {selectedDaySubs && (
                <DaySubscriptionsList
                  subscriptions={selectedDaySubs.subscriptions}
                  onSelectSubscription={onSelectSubscription}
                  onPrefetchSubscription={onPrefetchSubscription}
                  today={today}
                />
              )}
          </MobileBottomDrawerContent>
        )}
      </MobileDrawerRoot>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-primary" />
            {selectedDaySubs && t("calendar.dayRenewals", { date: selectedDayLabel })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {selectedDaySubs
              ? t("calendar.dayListDescription", { date: selectedDayLabel })
              : t("calendar.dayListFallbackDescription")}
          </DialogDescription>
        </DialogHeader>

        {selectedDaySubs && (
          <div className="grid max-h-[calc(var(--app-viewport-height)-8rem)] gap-2 overflow-y-auto">
            <DaySubscriptionsList
              subscriptions={selectedDaySubs.subscriptions}
              onSelectSubscription={onSelectSubscription}
              onPrefetchSubscription={onPrefetchSubscription}
              today={today}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
