import { Temporal } from "@js-temporal/polyfill";
import { isValidDateOnly, type BillingCycle, type CustomCycleUnit, type DateOnly } from "./runtime";
import { divideMoney, moneyToNumber, multiplyMoneyRatio, type MoneyString } from "./money";
import {
  addBillingCycles,
  calculateNextBillingDate as calculateRenewalNextBillingDate,
  requireCustomBillingCycle,
} from "./subscription-renewal";

const AVERAGE_DAYS_PER_MONTH = 30;

export interface SubscriptionBillingFields {
  billingCycle: BillingCycle;
  customDays?: number | null | undefined;
  customCycleUnit?: CustomCycleUnit | null | undefined;
  oneTimeTermCount?: number | null | undefined;
  oneTimeTermUnit?: CustomCycleUnit | null | undefined;
}

export type SubscriptionDailyCostBasis = "normalized" | "ownership-to-date";

export interface SubscriptionDailyCostProjection {
  amount: MoneyString;
  basis: SubscriptionDailyCostBasis;
}

export interface SubscriptionDailyCostFields extends SubscriptionBillingFields {
  startDate?: string | null | undefined;
}

/**
 * 将单次扣费金额折算成月均金额。
 *
 * 汇率换算不是本模块职责；调用方必须先把 amount 统一到目标币种，再做周期折算。
 */
export function toMonthlyAmount(
  amount: MoneyString | number,
  cycle: BillingCycle,
  customDays?: number | null | undefined,
  customCycleUnit?: CustomCycleUnit | null | undefined,
  oneTimeTermCount?: number | null | undefined,
  oneTimeTermUnit?: CustomCycleUnit | null | undefined,
): number {
  switch (cycle) {
    case "weekly":
      return moneyToNumber(multiplyMoneyRatio(amount, 433, 100));
    case "monthly":
      return moneyToNumber(amount);
    case "quarterly":
      return moneyToNumber(divideMoney(amount, 3));
    case "semi-annual":
      return moneyToNumber(divideMoney(amount, 6));
    case "annual":
      return moneyToNumber(divideMoney(amount, 12));
    case "custom": {
      const custom = requireCustomBillingCycle(customDays, customCycleUnit);
      return customCycleToMonthlyAmount(amount, custom.count, custom.unit);
    }
    case "one-time": {
      // one-time 无服务期是买断，不进入月均；固定服务期才把整段预付权益按月摊销。
      if (typeof oneTimeTermCount !== "number" || oneTimeTermCount <= 0) return 0;
      const term = requireCustomBillingCycle(oneTimeTermCount, oneTimeTermUnit);
      return customCycleToMonthlyAmount(amount, term.count, term.unit);
    }
  }
}

export function toSubscriptionMonthlyAmount(amount: MoneyString | number, subscription: SubscriptionBillingFields): number {
  return toMonthlyAmount(
    amount,
    subscription.billingCycle,
    subscription.customDays,
    subscription.customCycleUnit,
    subscription.oneTimeTermCount,
    subscription.oneTimeTermUnit,
  );
}

/**
 * 从调用方已经归一化的月均金额派生标准化日均成本。
 *
 * 固定 30 天仅用于跨周期比较；真实结算必须继续使用具体账期与日期规则。
 */
export function toDailyAmountFromMonthly(monthlyAmount: number): number {
  return monthlyAmount / AVERAGE_DAYS_PER_MONTH;
}

/**
 * 返回单条订阅唯一的日均投影：周期/固定服务期按标准月摊销，长期买断按实际持有自然日摊销。
 *
 * today 和购买日都是账号时区下的 date-only；未来、缺失或非法购买日没有已发生成本，返回 null。
 */
export function projectSubscriptionDailyCost(
  amount: MoneyString | number,
  subscription: SubscriptionDailyCostFields,
  today: string,
): SubscriptionDailyCostProjection | null {
  if (isOneTimeBuyout(subscription)) {
    if (!subscription.startDate || !isValidDateOnly(subscription.startDate) || !isValidDateOnly(today)) return null;
    const purchaseDate = Temporal.PlainDate.from(subscription.startDate);
    const asOf = Temporal.PlainDate.from(today);
    if (Temporal.PlainDate.compare(purchaseDate, asOf) > 0) return null;
    const ownershipDays = purchaseDate.until(asOf, { largestUnit: "day" }).days + 1;
    return { amount: divideMoney(amount, ownershipDays), basis: "ownership-to-date" };
  }

  const monthlyAmount = toSubscriptionMonthlyAmount(amount, subscription);
  return { amount: divideMoney(monthlyAmount, AVERAGE_DAYS_PER_MONTH), basis: "normalized" };
}

function customCycleToMonthlyAmount(amount: MoneyString | number, count: number, unit: CustomCycleUnit): number {
  switch (unit) {
    case "week":
      return moneyToNumber(multiplyMoneyRatio(amount, 433, count * 100));
    case "month":
      return moneyToNumber(divideMoney(amount, count));
    case "year":
      return moneyToNumber(divideMoney(amount, count * 12));
    case "day":
      return moneyToNumber(multiplyMoneyRatio(amount, AVERAGE_DAYS_PER_MONTH, count));
  }
}

export function isOneTimeFixedTerm(subscription: Pick<SubscriptionBillingFields, "billingCycle" | "oneTimeTermCount" | "oneTimeTermUnit">): boolean {
  return subscription.billingCycle === "one-time"
    && typeof subscription.oneTimeTermCount === "number"
    && subscription.oneTimeTermCount > 0;
}

export function isOneTimeBuyout(subscription: Pick<SubscriptionBillingFields, "billingCycle" | "oneTimeTermCount" | "oneTimeTermUnit">): boolean {
  return subscription.billingCycle === "one-time" && !isOneTimeFixedTerm(subscription);
}

export function calculateNextBillingDate(
  startDate: string,
  cycle: BillingCycle,
  customDays?: number | null | undefined,
  referenceDate?: string | null | undefined,
  customCycleUnit?: CustomCycleUnit | null | undefined,
): DateOnly {
  return calculateRenewalNextBillingDate(startDate, cycle, customDays, referenceDate, customCycleUnit);
}

export function calculateOneTimeTermEndDate(
  startDate: string,
  count: number,
  unit: CustomCycleUnit,
): DateOnly {
  return addBillingCycles(startDate, "custom", 1, count, unit);
}
