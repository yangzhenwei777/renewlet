import { Temporal } from "@js-temporal/polyfill";
import {
  type BillingCycle,
  type CustomCycleUnit,
  type DateOnly,
  type SubscriptionStatus,
  isValidDateOnly,
} from "./runtime";

/** 续订模式决定推进阈值：自动维护追到 today，手动续订至少推进一期并严格晚于当前边界。 */
export type RenewalMode = "auto" | "manual";

/** 续订算法输入是跨 D1、PocketBase 和前端 fixture 的最小字段集，不包含价格、通知或展示字段。 */
export interface SubscriptionRenewalInput {
  billingCycle: BillingCycle;
  status: SubscriptionStatus;
  startDate: string | null;
  nextBillingDate: string;
  autoRenew: boolean;
  autoCalculateNextBillingDate: boolean;
  customDays?: number | null | undefined;
  customCycleUnit?: CustomCycleUnit | null | undefined;
}

/** 账单日纯计算入口使用同一字段集，避免表单自动日期与后端续订算法分叉。 */
export interface AdvanceBillingDateInput {
  billingCycle: BillingCycle;
  startDate: string | null;
  nextBillingDate: string;
  autoCalculateNextBillingDate: boolean;
  customDays?: number | null | undefined;
  customCycleUnit?: CustomCycleUnit | null | undefined;
}

/** 续订结果只返回 date-only 与状态；不会生成付款记录或通知历史。 */
export interface SubscriptionRenewalResult {
  nextBillingDate: DateOnly;
  status: SubscriptionStatus;
}

const MAX_ADVANCE_CYCLES = 20_000;

function hasRenewalAnchor(input: Pick<AdvanceBillingDateInput, "autoCalculateNextBillingDate" | "nextBillingDate" | "startDate">): boolean {
  return input.autoCalculateNextBillingDate
    ? typeof input.startDate === "string" && isValidDateOnly(input.startDate)
    : isValidDateOnly(input.nextBillingDate);
}

/**
 * 判断订阅是否可由后台维护任务自动推进。
 *
 * 自动续订只处理已经落后于用户本地 today 的 active/trial 周期订阅；缺省 autoRenew 不能被解释成授权。
 */
export function isAutoRenewEligible(subscription: SubscriptionRenewalInput, today: string): boolean {
  return (
    subscription.autoRenew &&
    subscription.billingCycle !== "one-time" &&
    (subscription.status === "active" || subscription.status === "trial") &&
    isValidDateOnly(subscription.nextBillingDate) &&
    hasRenewalAnchor(subscription) &&
    isValidDateOnly(today) &&
    compareDateOnly(subscription.nextBillingDate, today) < 0
  );
}

/**
 * 判断订阅是否可由用户手动续订。
 *
 * 手动续订覆盖 expired 记录，但明确排除 autoRenew=true 的订阅，避免用户和维护 cron 同时推进同一账单日。
 */
export function isManualRenewEligible(subscription: SubscriptionRenewalInput): boolean {
  return (
    !subscription.autoRenew &&
    subscription.billingCycle !== "one-time" &&
    (subscription.status === "active" || subscription.status === "trial" || subscription.status === "expired") &&
    isValidDateOnly(subscription.nextBillingDate) &&
    hasRenewalAnchor(subscription)
  );
}

/**
 * 推进订阅续订状态，是 Docker Go、Cloudflare Worker 和前端测试共用的事实算法。
 *
 * `mode=auto` 推进到第一个 `>= today` 的周期日；`mode=manual` 至少推进一期并要求结果严格晚于阈值。
 */
export function advanceSubscriptionRenewal(
  subscription: SubscriptionRenewalInput,
  today: string,
  mode: RenewalMode,
): SubscriptionRenewalResult | null {
  if (mode === "auto" && !isAutoRenewEligible(subscription, today)) return null;
  if (mode === "manual" && !isManualRenewEligible(subscription)) return null;
  const nextBillingDate = advanceBillingDate(subscription, today, mode);
  return {
    nextBillingDate,
    status: mode === "manual" && subscription.status === "expired" ? "active" : subscription.status,
  };
}

/**
 * 计算下一账单日，不改变状态。
 *
 * `autoCalculateNextBillingDate=true` 以 startDate 作周期锚点；否则保留用户手动修正过的 nextBillingDate 锚点。
 * 周期订阅允许未知 startDate，因此只有自动锚点模式才需要 startDate。
 */
export function advanceBillingDate(
  input: AdvanceBillingDateInput,
  today: string,
  mode: RenewalMode,
): DateOnly {
  assertRenewableBillingCycle(input.billingCycle);
  const original = assertDateOnly(input.nextBillingDate);
  const anchor = assertDateOnly(input.autoCalculateNextBillingDate ? input.startDate ?? "" : input.nextBillingDate);
  const threshold = mode === "manual" && compareDateOnly(original, today) > 0 ? original : assertDateOnly(today);
  const strict = mode === "manual";

  return firstCycleDateAfter(anchor, input, threshold, strict);
}

/** 表单自动推算下一账单日的纯函数入口，保持 date-only 输出，不引入浏览器时区。 */
export function calculateNextBillingDate(
  startDate: string,
  cycle: BillingCycle,
  customDays?: number | null | undefined,
  referenceDate?: string | null | undefined,
  customCycleUnit?: CustomCycleUnit | null | undefined,
): DateOnly {
  const anchor = assertDateOnly(startDate);
  if (cycle === "one-time") return anchor;
  const threshold = referenceDate ? assertDateOnly(referenceDate) : anchor;
  return firstCycleDateAfter(anchor, {
    billingCycle: cycle,
    startDate: anchor,
    nextBillingDate: anchor,
    autoCalculateNextBillingDate: true,
    customDays,
    customCycleUnit,
  }, threshold, false);
}

/**
 * 将一个 date-only 按账单周期前进 N 期。
 *
 * 使用 Temporal 是为了让月末夹取语义稳定，例如 1 月 31 日按月推进到 2 月最后一天。
 */
export function addBillingCycles(
  date: string,
  cycle: BillingCycle,
  cycleCount: number,
  customDays?: number | null | undefined,
  customCycleUnit?: CustomCycleUnit | null | undefined,
): DateOnly {
  const start = toPlainDate(date);
  const count = Math.max(1, Math.trunc(cycleCount));
  switch (cycle) {
    case "weekly":
      return fromPlainDate(start.add({ weeks: count }));
    case "monthly":
      return fromPlainDate(start.add({ months: count }));
    case "quarterly":
      return fromPlainDate(start.add({ months: 3 * count }));
    case "semi-annual":
      return fromPlainDate(start.add({ months: 6 * count }));
    case "annual":
      return fromPlainDate(start.add({ years: count }));
    case "custom": {
      const custom = requireCustomBillingCycle(customDays, customCycleUnit);
      return addCustomBillingCycles(start, custom.count * count, custom.unit);
    }
    case "one-time":
      return fromPlainDate(start);
  }
}

function firstCycleDateAfter(
  anchor: string,
  input: AdvanceBillingDateInput,
  threshold: string,
  strict: boolean,
): DateOnly {
  const initialCycles = initialCycleCount(anchor, input, threshold, strict);
  let cycleCount = Math.max(1, initialCycles);
  for (let attempts = 0; attempts < MAX_ADVANCE_CYCLES; attempts += 1) {
    const candidate = addBillingCycles(anchor, input.billingCycle, cycleCount, input.customDays, input.customCycleUnit);
    const comparison = compareDateOnly(candidate, threshold);
    if (strict ? comparison > 0 : comparison >= 0) return candidate;
    cycleCount += 1;
  }
  // 保护异常自定义周期或脏数据，避免维护任务在单条订阅上无限循环占满 Worker/Go cron。
  throw new Error("SUBSCRIPTION_RENEWAL_ADVANCE_LIMIT_EXCEEDED");
}

function initialCycleCount(
  anchor: string,
  input: AdvanceBillingDateInput,
  threshold: string,
  strict: boolean,
): number {
  const dayStep = exactDayStep(input);
  if (!dayStep) return 1;
  // 只有“固定天数”周期能直接跳到接近阈值的期数；月份/年份必须逐期推进以保留月末夹取语义。
  const diff = toPlainDate(anchor).until(toPlainDate(threshold), { largestUnit: "day" }).days;
  const adjusted = strict ? diff + 1 : diff;
  return Math.max(1, Math.ceil(adjusted / dayStep));
}

function exactDayStep(input: Pick<AdvanceBillingDateInput, "billingCycle" | "customDays" | "customCycleUnit">): number | null {
  if (input.billingCycle === "weekly") return 7;
  if (input.billingCycle !== "custom") return null;
  const custom = requireCustomBillingCycle(input.customDays, input.customCycleUnit);
  if (custom.unit === "day") return custom.count;
  if (custom.unit === "week") return custom.count * 7;
  return null;
}

/** custom 周期在迁移后的所有运行面都必须显式携带正整数数量与单位。 */
export function requireCustomBillingCycle(
  customDays: number | null | undefined,
  customCycleUnit: CustomCycleUnit | null | undefined,
): { count: number; unit: CustomCycleUnit } {
  if (typeof customDays !== "number" || !Number.isInteger(customDays) || customDays <= 0 || !customCycleUnit) {
    throw new Error("SUBSCRIPTION_CUSTOM_CYCLE_INVALID");
  }
  return { count: customDays, unit: customCycleUnit };
}

function addCustomBillingCycles(
  start: Temporal.PlainDate,
  count: number,
  unit: CustomCycleUnit,
): DateOnly {
  switch (unit) {
    case "week":
      return fromPlainDate(start.add({ weeks: count }));
    case "month":
      return fromPlainDate(start.add({ months: count }));
    case "year":
      return fromPlainDate(start.add({ years: count }));
    case "day":
      return fromPlainDate(start.add({ days: count }));
  }
}

function assertRenewableBillingCycle(cycle: BillingCycle): asserts cycle is Exclude<BillingCycle, "one-time"> {
  if (cycle === "one-time") {
    throw new Error("SUBSCRIPTION_RENEWAL_ONE_TIME_NOT_RENEWABLE");
  }
}

function assertDateOnly(value: string): DateOnly {
  if (!isValidDateOnly(value)) {
    throw new Error(`Invalid date-only value: ${value}`);
  }
  return value as DateOnly;
}

function toPlainDate(value: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(assertDateOnly(value));
}

function fromPlainDate(value: Temporal.PlainDate): DateOnly {
  return assertDateOnly(value.toString());
}

function compareDateOnly(left: string, right: string): number {
  return Temporal.PlainDate.compare(toPlainDate(left), toPlainDate(right));
}
