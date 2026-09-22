/**
 * 统计页领域模型。
 *
 * 架构位置：
 * - 将金额换算、预算占比、分类/支付方式图表数据集中在纯函数中。
 * - 页面只负责渲染 Recharts 和统计卡片，避免图表 UI 反向承载业务规则。
 *
 * 数据流：
 * ```
 * 输入：subscriptions + settings.defaultCurrency + exchangeRates + customConfig
 *   -> buildStatisticsModel
 *   -> StatBox / PieChart view model
 * ```
 */
import { isOneTimeBuyout, toDailyAmountFromMonthly, toMonthlyAmount } from "@/lib/subscription-billing";
import { compareDateOnly, fromPlainDate, isSameMonthDateOnly, todayDateOnlyInTimeZone, toPlainDate, type DateOnly } from "@/lib/time/date-only";
import { DEFAULT_LOCALE, localizedLabel, type Locale } from "@/i18n/locales";
import { translate } from "@/i18n/messages";
import type { CustomConfig } from "@/types/config";
import type { SubscriptionCollectionItem } from "@/types/subscription";
import { addBillingCycles } from "@renewlet/shared/subscription-renewal";
import { calculateCostSharingSummary } from "@renewlet/shared/cost-sharing";
import { moneyToNumber } from "@renewlet/shared/money";
import { isEffectivelyActiveSubscription, isEffectivelyInactiveSubscription } from "./subscription-status";

/** 统计图表固定色板；保持跨图表颜色稳定，避免同一分类在不同渲染中频繁换色。 */
export const STATISTICS_CHART_COLORS = [
  "hsl(200 80% 50%)",
  "hsl(350 75% 55%)",
  "hsl(160 84% 45%)",
  "hsl(35 90% 55%)",
  "hsl(280 70% 55%)",
  "hsl(180 60% 45%)",
  "hsl(45 90% 50%)",
  "hsl(320 70% 55%)",
];

function chartColorAt(index: number): string {
  return STATISTICS_CHART_COLORS[index % STATISTICS_CHART_COLORS.length] ?? "hsl(200 80% 50%)";
}

const STATISTICS_TREND_MONTHS = 12;
const MAX_TREND_CASHFLOW_OCCURRENCES = 730;

export interface StatisticsTrendDatum {
  monthKey: string;
  label: string;
  cashflow: number;
  amortized: number;
  cashflowItems: StatisticsTrendItem[];
  amortizedItems: StatisticsTrendItem[];
}

export interface StatisticsTrendItem {
  subscriptionId: string;
  name: string;
  amount: number;
  firstDate: DateOnly | null;
  lastDate: DateOnly | null;
  occurrenceCount: number;
}

interface StatisticsTrendBucket extends StatisticsTrendDatum {
  startDate: DateOnly;
  endDate: DateOnly;
}

interface BuildStatisticsModelInput {
  subscriptions: readonly SubscriptionCollectionItem[];
  config: CustomConfig;
  monthlyBudget: string;
  defaultCurrency: string;
  convert: (amount: number | string, from: string, to: string) => number;
  now?: Date;
  timeZone?: string;
  locale?: Locale;
  costBasis?: "total" | "personal";
}

function roundTrendAmount(amount: number): number {
  return Math.round(amount * 1000) / 1000;
}

function toMonthKey(date: DateOnly | string): string {
  const value = toPlainDate(date);
  return `${value.year}-${String(value.month).padStart(2, "0")}`;
}

function buildTrendBuckets(today: DateOnly, locale: Locale): StatisticsTrendBucket[] {
  const startMonth = toPlainDate(today).with({ day: 1 });
  return Array.from({ length: STATISTICS_TREND_MONTHS }, (_, index) => {
    const monthStart = startMonth.add({ months: index });
    const monthEnd = monthStart.add({ months: 1 });
    return {
      monthKey: `${monthStart.year}-${String(monthStart.month).padStart(2, "0")}`,
      label: translate(locale, "statistics.trendMonthLabel", { year: monthStart.year, month: monthStart.month }),
      cashflow: 0,
      amortized: 0,
      cashflowItems: [],
      amortizedItems: [],
      startDate: fromPlainDate(monthStart),
      endDate: fromPlainDate(monthEnd),
    };
  });
}

function sortTrendItems(items: StatisticsTrendItem[]): StatisticsTrendItem[] {
  return items
    .map((item) => ({ ...item, amount: roundTrendAmount(item.amount) }))
    .sort((left, right) => {
      const amountDelta = right.amount - left.amount;
      return amountDelta !== 0 ? amountDelta : left.name.localeCompare(right.name);
    });
}

function addTrendItem(
  items: StatisticsTrendItem[],
  subscription: SubscriptionCollectionItem,
  amount: number,
  occurrenceDate: DateOnly | null,
) {
  const existing = items.find((item) => item.subscriptionId === subscription.id);
  if (!existing) {
    items.push({
      subscriptionId: subscription.id,
      name: subscription.name,
      amount,
      firstDate: occurrenceDate,
      lastDate: occurrenceDate,
      occurrenceCount: 1,
    });
    return;
  }

  existing.amount += amount;
  existing.occurrenceCount += 1;
  if (occurrenceDate) {
    if (!existing.firstDate || compareDateOnly(occurrenceDate, existing.firstDate) < 0) {
      existing.firstDate = occurrenceDate;
    }
    if (!existing.lastDate || compareDateOnly(occurrenceDate, existing.lastDate) > 0) {
      existing.lastDate = occurrenceDate;
    }
  }
}

function addCashflowTrend(
  bucketsByMonth: Map<string, StatisticsTrendBucket>,
  buckets: readonly StatisticsTrendBucket[],
  subscription: SubscriptionCollectionItem,
  amountInDefault: number,
) {
  if (subscription.billingCycle === "one-time" || buckets.length === 0) return;

  const firstBucket = buckets.at(0);
  const lastBucket = buckets.at(-1);
  if (!firstBucket || !lastBucket) return;
  const windowStart = firstBucket.startDate;
  const windowEnd = lastBucket.endDate;
  let dueDate: DateOnly = subscription.nextBillingDate;

  // autoRenew 只控制 Renewlet 是否后台推进日期，不代表第三方账单会停止；趋势按当前周期配置预测未来扣费。
  for (let occurrences = 0; compareDateOnly(dueDate, windowEnd) < 0 && occurrences < MAX_TREND_CASHFLOW_OCCURRENCES; occurrences += 1) {
    if (compareDateOnly(dueDate, windowStart) >= 0) {
      const bucket = bucketsByMonth.get(toMonthKey(dueDate));
      if (bucket) {
        bucket.cashflow += amountInDefault;
        addTrendItem(bucket.cashflowItems, subscription, amountInDefault, dueDate);
      }
    }

    const nextDueDate = addBillingCycles(
      dueDate,
      subscription.billingCycle,
      1,
      subscription.customDays,
      subscription.customCycleUnit,
    );
    if (compareDateOnly(nextDueDate, dueDate) <= 0) break;
    dueDate = nextDueDate;
  }
}

function addAmortizedTrend(
  buckets: readonly StatisticsTrendBucket[],
  subscription: SubscriptionCollectionItem,
  monthlyAmount: number,
) {
  if (monthlyAmount <= 0) return;

  if (subscription.billingCycle !== "one-time") {
    for (const bucket of buckets) {
      bucket.amortized += monthlyAmount;
      addTrendItem(bucket.amortizedItems, subscription, monthlyAmount, null);
    }
    return;
  }

  // 固定服务期 one-time 的到期日是权益结束边界，不是下一次扣费；只把服务覆盖月份计入摊销。
  if (!subscription.oneTimeTermCount) return;
  if (!subscription.startDate) return;
  for (const bucket of buckets) {
    const overlapsServiceWindow =
      compareDateOnly(subscription.startDate, bucket.endDate) < 0 &&
      compareDateOnly(subscription.nextBillingDate, bucket.startDate) >= 0;
    if (overlapsServiceWindow) {
      bucket.amortized += monthlyAmount;
      addTrendItem(bucket.amortizedItems, subscription, monthlyAmount, null);
    }
  }
}

function buildTrendData(
  activeSubscriptions: readonly SubscriptionCollectionItem[],
  today: DateOnly,
  locale: Locale,
  convertToDefault: (amount: number | string, currency: string) => number,
  amountForStats: (subscription: SubscriptionCollectionItem) => number | string,
  calculateMonthlyAmount: (subscription: SubscriptionCollectionItem) => number,
): StatisticsTrendDatum[] {
  const buckets = buildTrendBuckets(today, locale);
  const bucketsByMonth = new Map(buckets.map((bucket) => [bucket.monthKey, bucket]));

  for (const subscription of activeSubscriptions) {
    const amountInDefault = convertToDefault(amountForStats(subscription), subscription.currency);
    addCashflowTrend(bucketsByMonth, buckets, subscription, amountInDefault);
    addAmortizedTrend(buckets, subscription, calculateMonthlyAmount(subscription));
  }

  return buckets.map(({ monthKey, label, cashflow, amortized, cashflowItems, amortizedItems }) => ({
    monthKey,
    label,
    cashflow: roundTrendAmount(cashflow),
    amortized: roundTrendAmount(amortized),
    // 短周期订阅可能在同一自然月触发多次扣费；明细按订阅聚合，避免 tooltip 和读屏文本被逐次事件淹没。
    cashflowItems: sortTrendItems(cashflowItems),
    amortizedItems: sortTrendItems(amortizedItems),
  }));
}

/** 构建统计页视图模型。 */
export function buildStatisticsModel({
  subscriptions,
  config,
  monthlyBudget,
  defaultCurrency,
  convert,
  now = new Date(),
  timeZone = "UTC",
  locale = DEFAULT_LOCALE,
  costBasis = "total",
}: BuildStatisticsModelInput) {
  const today = todayDateOnlyInTimeZone(now, timeZone);
  const categoryByValue = new Map(config.categories.map((category) => [category.value, category]));
  const paymentMethodByValue = new Map(config.paymentMethods.map((method) => [method.value, method]));
  // 统计页是成本口径入口，必须用有效状态统一 active/trial/expired 的兼容语义，避免图表和列表筛选结果对不上。
  const activeSubscriptions = subscriptions.filter((subscription) => isEffectivelyActiveSubscription(subscription, today));
  const inactiveSubscriptions = subscriptions.filter((subscription) => isEffectivelyInactiveSubscription(subscription, today));
  const activeCostSubscriptions = activeSubscriptions.filter((subscription) => !isOneTimeBuyout(subscription));
  const inactiveCostSubscriptions = inactiveSubscriptions.filter((subscription) => !isOneTimeBuyout(subscription));
  const monthlyBudgetAmount = moneyToNumber(monthlyBudget);

  // costBasis 是统计页的金额口径开关；一旦选 personal，月均、日均、当月现金流、分类和趋势都必须使用个人份额。
  const amountForStats = (subscription: SubscriptionCollectionItem): number | string =>
    costBasis === "personal"
      ? calculateCostSharingSummary(subscription.costSharing, subscription.price, {
          baseCurrency: subscription.currency,
          convert,
        }).yourShare
      : subscription.price;
  const convertToDefault = (amount: number | string, currency: string) => convert(amount, currency, defaultCurrency);
  const calculateMonthlyAmount = (subscription: SubscriptionCollectionItem): number => {
    // 先换算币种再折算周期，保证所有图表都以用户当前统计货币为唯一口径。
    const amountInDefault = convertToDefault(amountForStats(subscription), subscription.currency);
    return toMonthlyAmount(
      amountInDefault,
      subscription.billingCycle,
      subscription.customDays,
      subscription.customCycleUnit,
      subscription.oneTimeTermCount,
      subscription.oneTimeTermUnit,
    );
  };

  const totalMonthly = activeCostSubscriptions.reduce((sum, subscription) => sum + calculateMonthlyAmount(subscription), 0);
  const totalDaily = toDailyAmountFromMonthly(totalMonthly);
  const totalAnnual = totalMonthly * 12;
  const avgMonthlyPerSub = activeCostSubscriptions.length > 0 ? totalMonthly / activeCostSubscriptions.length : 0;
  const mostExpensive = activeCostSubscriptions.reduce<SubscriptionCollectionItem | null>((max, subscription) => {
    // 使用月折算金额比较，而不是原始价格，避免年付订阅被低估。
    const currentMonthly = calculateMonthlyAmount(subscription);
    const maxMonthly = max ? calculateMonthlyAmount(max) : 0;
    return currentMonthly > maxMonthly ? subscription : max;
  }, null);
  const thisMonthDue = activeSubscriptions
    .filter((subscription) => subscription.billingCycle !== "one-time" && isSameMonthDateOnly(subscription.nextBillingDate, today))
    .reduce((sum, subscription) => sum + convertToDefault(amountForStats(subscription), subscription.currency), 0);
  const budgetUsedPercent = monthlyBudgetAmount > 0 ? (totalMonthly / monthlyBudgetAmount) * 100 : 0;
  const budgetRemaining = monthlyBudgetAmount - totalMonthly;
  const inactiveSavings = inactiveCostSubscriptions.reduce(
    (sum, subscription) => sum + calculateMonthlyAmount(subscription),
    0,
  );

  const categoryData = Object.entries(
    activeCostSubscriptions.reduce((acc, subscription) => {
      const amount = calculateMonthlyAmount(subscription);
      acc[subscription.category] = (acc[subscription.category] || 0) + amount;
      return acc;
    }, {} as Record<string, number>),
  ).map(([name, value], index) => {
    const category = categoryByValue.get(name);
    return {
      name: category ? localizedLabel(category.labels, locale) : name,
      value: Math.round(value * 1000) / 1000,
      color: category?.color ?? chartColorAt(index),
    };
  });

  const paymentData = Object.entries(
    activeSubscriptions.reduce((acc, subscription) => {
      const method = subscription.paymentMethod || "other";
      acc[method] = (acc[method] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  ).map(([name, value], index) => {
    const paymentMethod = paymentMethodByValue.get(name);
    return {
      name: paymentMethod ? localizedLabel(paymentMethod.labels, locale) : name,
      value,
      color: chartColorAt(index),
    };
  });

  const budgetChartData = [
    { name: translate(locale, "statistics.budgetUsed"), value: Math.min(totalMonthly, monthlyBudgetAmount), color: "hsl(350 75% 55%)" },
    { name: translate(locale, "statistics.budgetRemaining"), value: Math.max(budgetRemaining, 0), color: "hsl(200 80% 50%)" },
  ];
  const trendData = buildTrendData(activeCostSubscriptions, today, locale, convertToDefault, amountForStats, calculateMonthlyAmount);

  // TODO：若未来支持多预算周期，可把 monthlyBudget 和 budgetChartData 抽成独立预算 domain。
  return {
    activeCount: activeSubscriptions.length,
    inactiveCount: inactiveSubscriptions.length,
    totalMonthly,
    totalDaily,
    totalAnnual,
    avgMonthlyPerSub,
    mostExpensive,
    thisMonthDue,
    budgetUsedPercent,
    budgetRemaining,
    monthlySavings: inactiveSavings,
    annualSavings: inactiveSavings * 12,
    categoryData,
    paymentData,
    budgetChartData,
    trendData,
  };
}
