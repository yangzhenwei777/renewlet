/**
 * 续费/到期日历月视图入口（subscription-calendar.tsx）。
 *
 * 架构位置：这里持有当前月份、选中订阅和单日列表状态，负责把订阅
 * 将 DateOnly 分组为日历网格；详情视图复用通用 SubscriptionDetailDialog。
 *
 * 注意： nextBillingDate 已经是 DateOnly，分组时不能重新用 Date 解析，
 * 否则浏览器时区会导致续费日期跨日。
 */

import { useState, useMemo } from 'react';
import type { Subscription, SubscriptionCollectionItem } from '@/types/subscription';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { useExchangeRates } from '@/hooks/use-exchange-rates';
import { useSettings } from '@/hooks/use-settings';
import { useMediaQuery } from '@/hooks/use-media-query';
import {
  format,
  eachDayOfInterval,
  isSameMonth,
  isToday,
  addMonths,
  subMonths,
  setMonth,
  setYear
} from 'date-fns';
import { cn } from '@/lib/utils';
import { dateOnlyToLocalDate, dateToDateOnly, isSameMonthDateOnly, todayDateOnlyInTimeZone } from '@/lib/time/date-only';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/i18n/I18nProvider';
import { formatBillingCycleLabel, isOneTimeBuyout } from '@/lib/subscription-billing';
import { SubscriptionDetailDialog } from '@/components/subscription-detail-dialog';
import { DaySubscriptionsDialog } from './subscription-calendar-dialogs';
import type { CalendarDaySubscriptions } from './subscription-calendar-dialogs';
import { isEffectivelyActiveSubscription } from '@/modules/subscriptions/domain/subscription-status';
import { resolveSubscriptionPriceReferenceCurrency } from '@/modules/subscriptions/domain/subscription-price-reference';
import { getSubscriptionCalendarRange } from '@/modules/subscriptions/domain/subscription-calendar-range';
import { useSubscriptionDetailDialog } from '@/hooks/use-subscription-detail-dialog';

interface SubscriptionCalendarProps {
  /** 订阅列表（前端 domain 类型）。 */
  subscriptions: SubscriptionCollectionItem[];
  currentMonth: Date;
  onCurrentMonthChange: (month: Date) => void;
  /** 编辑动作交回上层 CRUD 控制器，完整对象由共享 detail cache 提供。 */
  onEditSubscription?: (id: string) => void;
}

const WEEKDAY_REFERENCE_DATES = [
  new Date(2024, 0, 1),
  new Date(2024, 0, 2),
  new Date(2024, 0, 3),
  new Date(2024, 0, 4),
  new Date(2024, 0, 5),
  new Date(2024, 0, 6),
  new Date(2024, 0, 7),
] as const;


/** 续费/到期日历组件。 */
export const SubscriptionCalendar = ({
  subscriptions,
  currentMonth,
  onCurrentMonthChange,
  onEditSubscription,
}: SubscriptionCalendarProps) => {
  const { t, locale, formatDateTime, formatCurrency } = useI18n();
  const isMobileCalendar = useMediaQuery("(max-width: 639px)");
  // 默认货币来自 Settings（持久化到 SQLite），用于日历底部“预计支出”的换算口径。
  const { data: settings } = useSettings();
  const defaultCurrency = settings?.defaultCurrency ?? 'CNY';
  const priceReferenceCurrency = settings ? resolveSubscriptionPriceReferenceCurrency(settings) : null;
  const today = todayDateOnlyInTimeZone(new Date(), settings?.timezone ?? "UTC");
  const { convert, loading: ratesLoading, sourceDate: ratesSourceDate } = useExchangeRates(settings?.exchangeRateProvider);
  const currencyRatesReady = Boolean(ratesSourceDate) && !ratesLoading;

  const {
    detailDialogOpen,
    selectedDetailSubscription,
    selectedDetailCollectionItem,
    detailPending,
    handlePrefetchDetails,
    handleViewDetails,
    handleDetailDialogOpenChange,
  } = useSubscriptionDetailDialog(subscriptions);
  const [dayListOpen, setDayListOpen] = useState(false);
  const [selectedDaySubs, setSelectedDaySubs] = useState<CalendarDaySubscriptions | null>(null);
  const [yearPickerOpen, setYearPickerOpen] = useState(false);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [yearRangeStart, setYearRangeStart] = useState(() => Math.floor(new Date().getFullYear() / 12) * 12);
  const monthLabels = useMemo(
    () => Array.from({ length: 12 }, (_, index) => formatDateTime(new Date(2024, index, 1), { month: "long" })),
    [formatDateTime],
  );
  const weekdayLabels = useMemo(
    () => WEEKDAY_REFERENCE_DATES.map((date) => formatDateTime(date, { weekday: "short" })),
    [formatDateTime],
  );

  // 将订阅按 “YYYY-MM-DD” 分组（同一天可能有多条订阅）。订阅日期已经是 DateOnly，
  // 这里不能再用 Date 解析，否则不同浏览器/服务器时区会让日历跨日。
  const subscriptionsByDate = useMemo(() => {
    const map = new Map<string, SubscriptionCollectionItem[]>();
    
    subscriptions
      // 日历展示真实扣费日和固定服务期到期日；one-time 买断没有下一次事件，不能把购买日塞进日历。
      .filter(sub => isEffectivelyActiveSubscription(sub, today) && !isOneTimeBuyout(sub))
      .forEach(sub => {
        const dateKey = sub.nextBillingDate;
        const existing = map.get(dateKey) || [];
        map.set(dateKey, [...existing, sub]);
      });
    
    return map;
  }, [subscriptions, today]);

  /**
   * 日历底部汇总：本月续费/到期事件数量 + 预计支出（换算到 defaultCurrency）。
   *
   * 说明：
   * - 预计支出按“本月发生续费”的订阅做一次性扣费汇总（不做月度折算）
   * - 汇率来自 useExchangeRates（缓存优先；失败时 fallback 到内置汇率）
   */
  const monthlySummary = useMemo(() => {
    let renewalsCount = 0;
    let estimatedSpending = 0;

    for (const [dateKey, daySubs] of subscriptionsByDate.entries()) {
      if (!isSameMonthDateOnly(dateKey, dateToDateOnly(currentMonth))) continue;

      renewalsCount += daySubs.length;
      for (const sub of daySubs) {
        estimatedSpending += convert(sub.price, sub.currency, defaultCurrency);
      }
    }

    return { renewalsCount, estimatedSpending };
  }, [subscriptionsByDate, currentMonth, convert, defaultCurrency]);

  // 生成当前月视图需要展示的日期网格（包含前后补齐的周）
  const calendarDays = useMemo(() => {
    const range = getSubscriptionCalendarRange(currentMonth);
    return eachDayOfInterval({
      start: dateOnlyToLocalDate(range.from),
      end: dateOnlyToLocalDate(range.to),
    });
  }, [currentMonth]);

  const monthlyAgendaGroups = useMemo(() => {
    return calendarDays
      .filter((day) => isSameMonth(day, currentMonth))
      .map((day) => {
        const dateKey = format(day, 'yyyy-MM-dd');
        return {
          date: day,
          dateKey,
          subscriptions: subscriptionsByDate.get(dateKey) || [],
        };
      })
      .filter((group) => group.subscriptions.length > 0);
  }, [calendarDays, currentMonth, subscriptionsByDate]);

  const goToPreviousMonth = () => onCurrentMonthChange(subMonths(currentMonth, 1));
  const goToNextMonth = () => onCurrentMonthChange(addMonths(currentMonth, 1));
  const goToToday = () => onCurrentMonthChange(new Date());

  const handleSubscriptionClick = (sub: SubscriptionCollectionItem) => {
    handleViewDetails(sub.id);
  };

  const handleShowDayList = (date: Date, subs: SubscriptionCollectionItem[]) => {
    setSelectedDaySubs({ date, subscriptions: subs });
    setDayListOpen(true);
  };

  const handleSelectFromList = (sub: SubscriptionCollectionItem) => {
    setDayListOpen(false);
    handleViewDetails(sub.id);
  };

  const handleEditFromDetail = (subscription: Subscription) => {
    onEditSubscription?.(subscription.id);
  };

  return (
    <>
      <div className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-card sm:p-6">
        {/* 顶部栏 */}
        <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-primary" />
            <h3 className="text-lg font-semibold text-foreground">{t("calendar.title")}</h3>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 sm:justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={goToToday}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {t("common.today")}
            </Button>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("calendar.previousMonth")}
                className="h-8 w-8"
                onClick={goToPreviousMonth}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              
              {/* 年份选择器 */}
              <Popover open={yearPickerOpen} onOpenChange={setYearPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    className="h-8 px-2 text-sm font-medium hover:bg-secondary"
                  >
                    {formatDateTime(currentMonth, { year: "numeric" })}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-70 p-3" align="center">
                  <div className="flex items-center justify-between mb-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setYearRangeStart(prev => prev - 12)}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-primary hover:text-primary"
                      onClick={() => {
                        const today = new Date();
                        onCurrentMonthChange(today);
                        setYearRangeStart(Math.floor(today.getFullYear() / 12) * 12);
                        setYearPickerOpen(false);
                      }}
                    >
                      {t("common.today")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setYearRangeStart(prev => prev + 12)}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {Array.from({ length: 12 }, (_, i) => {
                      const year = yearRangeStart + i;
                      const isSelected = year === currentMonth.getFullYear();
                      const isCurrent = year === new Date().getFullYear();
                      return (
                        <button
                          key={year}
                          onClick={() => {
                            onCurrentMonthChange(setYear(currentMonth, year));
                            setYearPickerOpen(false);
                          }}
                          className={cn(
                            "h-9 rounded-lg text-sm font-medium transition-all",
                            isSelected 
                              ? "bg-primary text-primary-foreground" 
                              : isCurrent
                                ? "bg-accent text-accent-foreground hover:bg-accent/80"
                                : "hover:bg-secondary text-foreground"
                          )}
                        >
                          {year}
                        </button>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
              
              {/* 月份选择器 */}
              <Popover open={monthPickerOpen} onOpenChange={setMonthPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    className="h-8 px-2 text-sm font-medium hover:bg-secondary"
                  >
                    {formatDateTime(currentMonth, { month: "long" })}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-60 p-3" align="center">
                  <div className="flex items-center justify-center mb-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-primary hover:text-primary"
                      onClick={() => {
                        onCurrentMonthChange(new Date());
                        setMonthPickerOpen(false);
                      }}
                    >
                      {t("common.today")}
                    </Button>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {monthLabels.map((month, index) => {
                      const isSelected = index === currentMonth.getMonth();
                      const isCurrent = index === new Date().getMonth() && 
                                       currentMonth.getFullYear() === new Date().getFullYear();
                      return (
                        <button
                          key={month}
                          onClick={() => {
                            onCurrentMonthChange(setMonth(currentMonth, index));
                            setMonthPickerOpen(false);
                          }}
                          className={cn(
                            "h-9 rounded-lg text-sm font-medium transition-all",
                            isSelected 
                              ? "bg-primary text-primary-foreground" 
                              : isCurrent
                                ? "bg-accent text-accent-foreground hover:bg-accent/80"
                                : "hover:bg-secondary text-foreground"
                          )}
                        >
                          {month}
                        </button>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
              
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("calendar.nextMonth")}
                className="h-8 w-8"
                onClick={goToNextMonth}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* 星期标题 */}
        <div className="mb-2 grid grid-cols-7">
          {weekdayLabels.map((day) => (
            <div
              key={day}
              className="py-2 text-center text-[11px] font-medium text-muted-foreground sm:text-xs"
            >
              {day}
            </div>
          ))}
        </div>

        {isMobileCalendar ? (
          <>
            {/* 移动端月历概览：只展示事件指示，完整信息放到下方列表。 */}
            <div className="grid min-w-0 grid-cols-7 gap-1">
              {calendarDays.map((day) => {
                const dateKey = format(day, 'yyyy-MM-dd');
                const daySubs = subscriptionsByDate.get(dateKey) || [];
                const isCurrentMonth = isSameMonth(day, currentMonth);
                const isDayToday = isToday(day);
                const dayLabel = formatDateTime(day, { month: "short", day: "numeric" });
                const hasRenewals = daySubs.length > 0;
                const dayContent = (
                  <>
                    <span
                      className={cn(
                        "flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium",
                        isDayToday && "bg-primary text-primary-foreground font-semibold",
                        !isDayToday && isCurrentMonth && "text-foreground",
                        !isDayToday && !isCurrentMonth && "text-muted-foreground/45",
                      )}
                    >
                      {format(day, 'd')}
                    </span>
                    <span className="flex h-4 items-center justify-center">
                      {daySubs.length === 1 && (
                        <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                      )}
                      {daySubs.length > 1 && (
                        <span className="min-w-4 rounded-full bg-primary/15 px-1 text-[10px] font-semibold leading-4 text-primary">
                          {daySubs.length}
                        </span>
                      )}
                    </span>
                  </>
                );

                if (!hasRenewals) {
                  return (
                    <div
                      key={dateKey}
                      className={cn(
                        "flex min-h-11 flex-col items-center justify-center rounded-lg transition-colors",
                        isCurrentMonth ? "bg-secondary/30" : "bg-muted/20",
                      )}
                    >
                      {dayContent}
                    </div>
                  );
                }

                return (
                  <button
                    key={dateKey}
                    type="button"
                    aria-label={t("calendar.dayRenewalCount", { date: dayLabel, count: daySubs.length })}
                    onClick={() => handleShowDayList(day, daySubs)}
                    className={cn(
                      "flex min-h-11 flex-col items-center justify-center rounded-lg border border-border bg-secondary/40 transition-colors hover:border-primary/40 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                      !isCurrentMonth && "bg-muted/30",
                    )}
                  >
                    {dayContent}
                  </button>
                );
              })}
            </div>

            <div className="mt-5 min-w-0 max-w-full border-t border-border pt-4" data-testid="calendar-mobile-agenda">
              <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
                <h4 className="min-w-0 truncate text-sm font-semibold text-foreground">{t("calendar.mobileAgendaTitle")}</h4>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t("calendar.renewalCount", { count: monthlySummary.renewalsCount })}
                </span>
              </div>

              {monthlyAgendaGroups.length > 0 ? (
                <div className="grid min-w-0 max-w-full grid-cols-1 gap-4" data-testid="calendar-mobile-agenda-list">
                  {monthlyAgendaGroups.map((group) => {
                    const groupLabel = formatDateTime(group.date, {
                      month: "short",
                      day: "numeric",
                      weekday: "short",
                    });

                    return (
                      <section key={group.dateKey} className="grid min-w-0 max-w-full grid-cols-1 gap-2">
                        <div className="flex min-w-0 items-center justify-between gap-3 text-xs">
                          <span className="min-w-0 truncate font-medium text-muted-foreground">{groupLabel}</span>
                          <span className="shrink-0 text-primary">
                            {t("calendar.dayRenewalCount", {
                              date: formatDateTime(group.date, { month: "short", day: "numeric" }),
                              count: group.subscriptions.length,
                            })}
                          </span>
                        </div>
                        <div className="grid min-w-0 max-w-full grid-cols-1 gap-2">
                          {group.subscriptions.map((sub) => (
                            <button
                              key={sub.id}
                              type="button"
                              onClick={() => handleSubscriptionClick(sub)}
                              onPointerEnter={() => handlePrefetchDetails(sub.id)}
                              onFocus={() => handlePrefetchDetails(sub.id)}
                              className="flex min-h-14 min-w-0 max-w-full items-center justify-between gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-3 text-left transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                              data-testid="calendar-mobile-agenda-item"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-foreground">{sub.name}</p>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  {formatBillingCycleLabel(sub, locale)}
                                </p>
                              </div>
                              <p className="max-w-[45%] shrink-0 truncate text-right text-sm font-semibold text-foreground">
                                {formatCurrency(sub.price, sub.currency)}
                              </p>
                            </button>
                          ))}
                        </div>
                      </section>
                    );
                  })}
                </div>
              ) : (
                <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-secondary/30 px-4 text-center">
                  <CalendarDays className="mb-3 h-6 w-6 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">{t("calendar.mobileAgendaEmpty")}</p>
                </div>
              )}
            </div>
          </>
        ) : (
          /* 日历网格 */
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg bg-border/50">
            {calendarDays.map((day) => {
              const dateKey = format(day, 'yyyy-MM-dd');
              const daySubs = subscriptionsByDate.get(dateKey) || [];
              const isCurrentMonth = isSameMonth(day, currentMonth);
              const isDayToday = isToday(day);

              return (
                <div
                  key={dateKey}
                  className={cn(
                    "min-h-20 bg-card p-1.5 transition-colors",
                    !isCurrentMonth && "bg-muted/30"
                  )}
                >
                  {/* 日期数字 */}
                  <div className="mb-1 flex justify-end">
                    <span
                      className={cn(
                        "flex h-6 w-6 items-center justify-center rounded-full text-xs",
                        isDayToday && "bg-primary text-primary-foreground font-semibold",
                        !isDayToday && isCurrentMonth && "text-foreground",
                        !isDayToday && !isCurrentMonth && "text-muted-foreground/50"
                      )}
                    >
                      {format(day, 'd')}
                    </span>
                  </div>

                  {/* 订阅项 */}
                  <div className="grid gap-0.5">
                    <TooltipProvider delayDuration={200}>
                      {daySubs.slice(0, 2).map((sub) => (
                        <Tooltip key={sub.id}>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => handleSubscriptionClick(sub)}
                              onPointerEnter={() => handlePrefetchDetails(sub.id)}
                              onFocus={() => handlePrefetchDetails(sub.id)}
                              className={cn(
                                "w-full truncate rounded border px-1.5 py-0.5 text-left text-xs transition-colors",
                                "border-border bg-background text-foreground hover:bg-secondary/60",
                                "cursor-pointer hover:border-border"
                              )}
                            >
                              {sub.name}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">
                            <p className="font-medium">{sub.name}</p>
                            <p className="text-muted-foreground">
                              {formatCurrency(sub.price, sub.currency)}
                            </p>
                            <p className="text-muted-foreground/70">{t("calendar.viewDetails")}</p>
                          </TooltipContent>
                        </Tooltip>
                      ))}
                      {daySubs.length > 2 && (
                        <button
                          onClick={() => handleShowDayList(day, daySubs)}
                          className="w-full cursor-pointer text-center text-xs text-primary hover:text-primary-glow hover:underline"
                        >
                          {t("calendar.more", { count: daySubs.length - 2 })}
                        </button>
                      )}
                    </TooltipProvider>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 月度汇总 */}
        <div className="mt-4 border-t border-border pt-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="text-sm">
              <span className="text-muted-foreground">{t("calendar.monthlyRenewals")}</span>
              <p className="font-semibold text-foreground mt-1">
                {t("calendar.renewalCount", { count: monthlySummary.renewalsCount })}
              </p>
            </div>
            <div className="text-sm text-right">
              <span className="text-muted-foreground">{t("calendar.estimatedSpend")}</span>
              <p className="font-semibold text-foreground mt-1">
                {formatCurrency(monthlySummary.estimatedSpending, defaultCurrency)}
              </p>
            </div>
          </div>
        </div>
      </div>


      <SubscriptionDetailDialog
        open={detailDialogOpen}
        onOpenChange={handleDetailDialogOpenChange}
        subscription={selectedDetailSubscription}
        loadingPreview={selectedDetailCollectionItem}
        today={today}
        currencyConvert={convert}
        currencyRatesReady={currencyRatesReady}
        priceReferenceCurrency={priceReferenceCurrency}
        loading={detailPending}
        {...(onEditSubscription ? { onEditSubscription: handleEditFromDetail } : {})}
      />

      <DaySubscriptionsDialog
        open={dayListOpen}
        onOpenChange={setDayListOpen}
        selectedDaySubs={selectedDaySubs}
        onSelectSubscription={handleSelectFromList}
        onPrefetchSubscription={handlePrefetchDetails}
        today={today}
        isMobile={isMobileCalendar}
      />
    </>
  );
};
