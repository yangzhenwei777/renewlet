/**
 * 订阅筛选领域逻辑。
 *
 * 架构位置：
 * - 页面和 hook 管理筛选/排序状态，domain 只关心“给定状态如何得到结果”。
 * - 纯函数便于后续补单测，避免搜索/标签/排序逻辑散落在列表页 JSX 中。
 */
import { DEFAULT_LOCALE, type Locale } from "@/i18n/locales";
import { isOneTimeBuyout, isOneTimeFixedTerm, toMonthlyAmount } from "@/lib/subscription-billing";
import { assertDateOnly, compareDateOnly, type DateOnly } from "@/lib/time/date-only";
import type { SubscriptionListFilters } from "@/services/subscription-service";
import type {
  BillingCycle,
  Category,
  Subscription,
  SubscriptionCollectionItem,
  SubscriptionStatus,
} from "@/types/subscription";
import { compareMoney } from "@renewlet/shared/money";
import { SUBSCRIPTION_PAYMENT_METHOD_NONE } from "@renewlet/shared/schemas/subscriptions";
import { DISABLED_REMINDER_DAYS, INHERIT_REMINDER_DAYS } from "@renewlet/shared/runtime";
import {
  getEffectiveSubscriptionStatus,
  isEffectivelyInactiveSubscription,
} from "./subscription-status";

export interface SubscriptionFilterState {
  searchQuery: string;
  selectedCategories: Category[];
  statusFilter: SubscriptionStatus | "all";
  paymentTypeFilter: SubscriptionPaymentTypeFilter;
  selectedTags: string[];
}

export type SubscriptionBooleanFilter = "all" | "yes" | "no";
export type SubscriptionReminderModeFilter = "all" | "disabled" | "inherit" | "custom";

export interface SubscriptionAdvancedFilterState {
  selectedBillingCycles: BillingCycle[];
  selectedPaymentMethods: string[];
  selectedCurrencies: string[];
  nextBillingFrom: string;
  nextBillingTo: string;
  pinnedFilter: SubscriptionBooleanFilter;
  publicHiddenFilter: SubscriptionBooleanFilter;
  reminderModeFilter: SubscriptionReminderModeFilter;
  repeatReminderFilter: SubscriptionBooleanFilter;
}

export const SUBSCRIPTION_PAYMENT_METHOD_NONE_VALUE = SUBSCRIPTION_PAYMENT_METHOD_NONE;

export const DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS: SubscriptionAdvancedFilterState = {
  selectedBillingCycles: [],
  selectedPaymentMethods: [],
  selectedCurrencies: [],
  nextBillingFrom: "",
  nextBillingTo: "",
  pinnedFilter: "all",
  publicHiddenFilter: "all",
  reminderModeFilter: "all",
  repeatReminderFilter: "all",
};

export interface SubscriptionFilterContext {
  today: DateOnly | string;
}

export const SUBSCRIPTION_SORT_OPTIONS = [
  "default",
  "renewal_asc",
  "renewal_desc",
  "monthly_cost_desc",
  "monthly_cost_asc",
  "price_desc",
  "price_asc",
  "name_asc",
  "name_desc",
] as const;

/** 订阅列表排序选项。 */
export type SubscriptionSortOption = (typeof SUBSCRIPTION_SORT_OPTIONS)[number];

export const SUBSCRIPTION_PAYMENT_TYPE_FILTERS = [
  "all",
  "auto",
  "manual",
  "one-time-buyout",
  "one-time-fixed-term",
] as const;
export type SubscriptionPaymentTypeFilter = (typeof SUBSCRIPTION_PAYMENT_TYPE_FILTERS)[number];

export interface SubscriptionSortContext {
  sortOption: SubscriptionSortOption;
  today: DateOnly | string;
  defaultCurrency: string;
  convert: (amount: number | string, from: string, to: string) => number;
  locale?: Locale;
}

/** 按搜索、分类、状态和标签筛选订阅。 */
export function filterSubscriptions(
  subscriptions: readonly Subscription[],
  filters: SubscriptionFilterState,
  { today }: SubscriptionFilterContext,
): Subscription[] {
  const query = filters.searchQuery.trim().toLowerCase();

  return subscriptions.filter((subscription) => {
    // 搜索覆盖名称、站点、备注和标签；这是用户最常用的“模糊找订阅”入口。
    if (query) {
      const matches =
        subscription.name.toLowerCase().includes(query) ||
        subscription.website?.toLowerCase().includes(query) ||
        subscription.notes?.toLowerCase().includes(query) ||
        (subscription.tags ?? []).some((tag) => tag.toLowerCase().includes(query));
      if (!matches) return false;
    }

    // 订阅本身仍是单分类，多选筛选只能用 OR：命中任一已选分类即可保留。
    if (
      filters.selectedCategories.length > 0 &&
      !filters.selectedCategories.includes(subscription.category)
    ) {
      return false;
    }

    // 状态筛选必须走“有效状态”，否则旧 active/trial 过期记录无法被“已过期”筛出，也会继续出现在“活跃/试用中”。
    if (filters.statusFilter !== "all" && getEffectiveSubscriptionStatus(subscription, today) !== filters.statusFilter) {
      return false;
    }

    if (filters.paymentTypeFilter === "one-time-buyout" && !isOneTimeBuyout(subscription)) {
      return false;
    }
    if (filters.paymentTypeFilter === "one-time-fixed-term" && !isOneTimeFixedTerm(subscription)) {
      return false;
    }
    if (filters.paymentTypeFilter === "auto" && (subscription.billingCycle === "one-time" || !subscription.autoRenew)) {
      return false;
    }
    if (filters.paymentTypeFilter === "manual" && (subscription.billingCycle === "one-time" || subscription.autoRenew)) {
      return false;
    }

    // 标签筛选使用 OR 语义：选中任一标签即可命中，符合“快速缩小范围”的交互直觉。
    if (
      filters.selectedTags.length > 0 &&
      !filters.selectedTags.some((tag) => subscription.tags?.includes(tag))
    ) {
      return false;
    }

    return true;
  });
}

function matchesOptionalValues(values: readonly string[] | undefined, actual: string): boolean {
  return !values?.length || values.includes(actual);
}

function matchesPaymentMethod(values: readonly string[] | undefined, actual: string | undefined): boolean {
  if (!values?.length) return true;
  if (!actual && values.includes(SUBSCRIPTION_PAYMENT_METHOD_NONE)) return true;
  return actual !== undefined && values.includes(actual);
}

/**
 * 在完整导出 DTO 上重放 collection 查询语义。
 * 列表展示仍以服务端 index 为事实源；该函数只用于显式 CSV 导出和同契约测试 fixture。
 */
export function filterSubscriptionsByListFilters(
  subscriptions: readonly Subscription[],
  filters: SubscriptionListFilters | undefined,
  context: SubscriptionFilterContext,
): Subscription[] {
  const filtered = filterSubscriptions(subscriptions, {
    searchQuery: filters?.q ?? "",
    selectedCategories: filters?.category ?? [],
    statusFilter: filters?.status ?? "all",
    paymentTypeFilter: filters?.paymentType ?? "all",
    selectedTags: filters?.tag ?? [],
  }, context);

  return filtered.filter((subscription) => {
    if (!matchesOptionalValues(filters?.billingCycle, subscription.billingCycle)) return false;
    if (!matchesPaymentMethod(filters?.paymentMethod, subscription.paymentMethod)) return false;
    if (!matchesOptionalValues(filters?.currency, subscription.currency)) return false;
    if ((filters?.nextBillingFrom || filters?.nextBillingTo) && isOneTimeBuyout(subscription)) return false;
    if (filters?.nextBillingFrom && subscription.nextBillingDate < filters.nextBillingFrom) return false;
    if (filters?.nextBillingTo && subscription.nextBillingDate > filters.nextBillingTo) return false;
    if (filters?.pinned !== undefined && subscription.pinned !== filters.pinned) return false;
    if (filters?.publicHidden !== undefined && subscription.publicHidden !== filters.publicHidden) return false;
    if (filters?.repeatReminder !== undefined && subscription.repeatReminderEnabled !== filters.repeatReminder) return false;
    if (filters?.reminderMode === "disabled" && subscription.reminderDays !== DISABLED_REMINDER_DAYS) return false;
    if (filters?.reminderMode === "inherit" && subscription.reminderDays !== INHERIT_REMINDER_DAYS) return false;
    if (filters?.reminderMode === "custom" && subscription.reminderDays < 0) return false;
    return true;
  });
}

function getSortDirection(sortOption: SubscriptionSortOption): 1 | -1 {
  return sortOption.endsWith("_desc") ? -1 : 1;
}

function calculateMonthlyCost(
  subscription: SubscriptionCollectionItem,
  defaultCurrency: string,
  convert: (amount: number | string, from: string, to: string) => number,
): number | null {
  if (isOneTimeBuyout(subscription)) return null;
  const amountInDefault = convert(subscription.price, subscription.currency, defaultCurrency);
  return toMonthlyAmount(
    amountInDefault,
    subscription.billingCycle,
    subscription.customDays,
    subscription.customCycleUnit,
    subscription.oneTimeTermCount,
    subscription.oneTimeTermUnit,
  );
}

function comparePinnedFirst(left: SubscriptionCollectionItem, right: SubscriptionCollectionItem): number {
  if (left.pinned === right.pinned) return 0;
  return left.pinned ? -1 : 1;
}

function nextAttentionDate(
  subscription: SubscriptionCollectionItem,
  today: DateOnly | string,
  inactive: boolean,
): DateOnly | string | null {
  if (isOneTimeBuyout(subscription)) return null;
  if (inactive) return subscription.nextBillingDate;
  if (subscription.status !== "trial") return subscription.nextBillingDate;

  const candidates = [subscription.trialEndDate, subscription.nextBillingDate]
    .filter((date): date is DateOnly => date !== undefined && compareDateOnly(date, today) >= 0);
  return candidates.reduce<DateOnly | string | null>(
    (earliest, date) => earliest === null || compareDateOnly(date, earliest) < 0 ? date : earliest,
    null,
  );
}

function compareNullableDateOnly(
  left: DateOnly | string | null,
  right: DateOnly | string | null,
  direction: 1 | -1,
): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return compareDateOnly(left, right) * direction;
}

function compareNullableNumber(left: number | null, right: number | null, direction: 1 | -1): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return (left - right) * direction;
}

/** 按指定选项对订阅排序；相同排序值保持传入顺序，避免列表无意义跳动。 */
export function sortSubscriptions<T extends SubscriptionCollectionItem>(
  subscriptions: readonly T[],
  { sortOption, today, defaultCurrency, convert, locale = DEFAULT_LOCALE }: SubscriptionSortContext,
): T[] {
  const direction = getSortDirection(sortOption);
  const sortsByAttentionDate = sortOption === "renewal_asc" || sortOption === "renewal_desc";
  const collator = sortOption === "name_asc" || sortOption === "name_desc"
    ? new Intl.Collator(locale, { sensitivity: "base", numeric: true })
    : null;
  const decorated = subscriptions.map((subscription, index) => {
    const inactive = isEffectivelyInactiveSubscription(subscription, today);
    return {
      subscription,
      index,
      inactive,
      attentionDate: sortsByAttentionDate ? nextAttentionDate(subscription, today, inactive) : null,
      monthlyCost:
        sortOption === "monthly_cost_asc" || sortOption === "monthly_cost_desc"
          ? calculateMonthlyCost(subscription, defaultCurrency, convert)
          : null,
    };
  });

  return decorated
    .sort((left, right) => {
      const pinnedComparison = comparePinnedFirst(left.subscription, right.subscription);
      if (pinnedComparison !== 0) return pinnedComparison;

      // 置顶是用户的人工覆盖意图；只在同一置顶组内按生命周期分组，不能把置顶的非活跃项压到未置顶项之后。
      if (left.inactive !== right.inactive) return left.inactive ? 1 : -1;

      let comparison = 0;

      switch (sortOption) {
        case "default":
          break;
        case "renewal_asc":
        case "renewal_desc":
          return compareNullableDateOnly(
            left.attentionDate,
            right.attentionDate,
            direction,
          ) || left.index - right.index;
        case "monthly_cost_asc":
        case "monthly_cost_desc":
          return compareNullableNumber(left.monthlyCost, right.monthlyCost, direction) || left.index - right.index;
        case "price_asc":
        case "price_desc":
          comparison = compareMoney(left.subscription.price, right.subscription.price);
          break;
        case "name_asc":
        case "name_desc":
          comparison = collator?.compare(left.subscription.name, right.subscription.name) ?? 0;
          break;
      }

      if (comparison === 0) return left.index - right.index;
      return comparison * direction;
    })
    .map((item) => item.subscription);
}

/** 判断当前是否存在任何筛选条件。 */
export function hasActiveSubscriptionFilters(filters: SubscriptionFilterState): boolean {
  return Boolean(
    filters.searchQuery.trim() ||
      filters.selectedCategories.length > 0 ||
      filters.statusFilter !== "all" ||
      filters.paymentTypeFilter !== "all" ||
      filters.selectedTags.length > 0,
  );
}

export function hasActiveSubscriptionAdvancedFilters(filters: SubscriptionAdvancedFilterState): boolean {
  return Boolean(
    filters.selectedBillingCycles.length > 0 ||
      filters.selectedPaymentMethods.length > 0 ||
      filters.selectedCurrencies.length > 0 ||
      filters.nextBillingFrom ||
      filters.nextBillingTo ||
      filters.pinnedFilter !== "all" ||
      filters.publicHiddenFilter !== "all" ||
      filters.reminderModeFilter !== "all" ||
      filters.repeatReminderFilter !== "all",
  );
}

function booleanFilterToQuery(value: SubscriptionBooleanFilter): boolean | undefined {
  if (value === "yes") return true;
  if (value === "no") return false;
  return undefined;
}

export function buildSubscriptionListFilters(
  filters: SubscriptionFilterState,
  advancedFilters: SubscriptionAdvancedFilterState = DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
): SubscriptionListFilters | undefined {
  const query: SubscriptionListFilters = {};
  const searchQuery = filters.searchQuery.trim();
  if (searchQuery) query.q = searchQuery;
  if (filters.selectedCategories.length > 0) query.category = filters.selectedCategories;
  if (filters.selectedTags.length > 0) query.tag = filters.selectedTags;
  if (filters.statusFilter !== "all") query.status = filters.statusFilter;
  if (filters.paymentTypeFilter !== "all") query.paymentType = filters.paymentTypeFilter;
  if (advancedFilters.selectedBillingCycles.length > 0) query.billingCycle = advancedFilters.selectedBillingCycles;
  if (advancedFilters.selectedPaymentMethods.length > 0) query.paymentMethod = advancedFilters.selectedPaymentMethods;
  if (advancedFilters.selectedCurrencies.length > 0) query.currency = advancedFilters.selectedCurrencies;
  if (advancedFilters.nextBillingFrom) query.nextBillingFrom = assertDateOnly(advancedFilters.nextBillingFrom);
  if (advancedFilters.nextBillingTo) query.nextBillingTo = assertDateOnly(advancedFilters.nextBillingTo);
  const pinned = booleanFilterToQuery(advancedFilters.pinnedFilter);
  if (pinned !== undefined) query.pinned = pinned;
  const publicHidden = booleanFilterToQuery(advancedFilters.publicHiddenFilter);
  if (publicHidden !== undefined) query.publicHidden = publicHidden;
  if (advancedFilters.reminderModeFilter !== "all") query.reminderMode = advancedFilters.reminderModeFilter;
  const repeatReminder = booleanFilterToQuery(advancedFilters.repeatReminderFilter);
  if (repeatReminder !== undefined) query.repeatReminder = repeatReminder;
  return Object.keys(query).length > 0 ? query : undefined;
}
