import type { MessageKey } from "@/i18n/messages";
import type { Locale } from "@/i18n/locales";
import type { BillingCycle, CustomCycleUnit, SubscriptionStatus } from "@/types/subscription";
import type { SubscriptionFormState } from "@/types/subscription-form";
import { moneyToNumber } from "@renewlet/shared/money";

export const BILLING_CYCLE_LABEL_KEYS: Record<BillingCycle, MessageKey> = {
  weekly: "cycle.weekly",
  monthly: "cycle.monthly",
  quarterly: "cycle.quarterly",
  "semi-annual": "cycle.semiAnnual",
  annual: "cycle.annual",
  custom: "cycle.custom",
  "one-time": "cycle.oneTime",
};
export const STATUS_LABEL_KEYS: Record<SubscriptionStatus, MessageKey> = {
  trial: "status.trial",
  active: "status.active",
  expired: "status.expired",
  paused: "status.paused",
  cancelled: "status.cancelled",
};
export const CUSTOM_CYCLE_UNIT_LABEL_KEYS: Record<CustomCycleUnit, MessageKey> = {
  day: "subscription.customCycleUnit.day",
  week: "subscription.customCycleUnit.week",
  month: "subscription.customCycleUnit.month",
  year: "subscription.customCycleUnit.year",
};

// 搜索必须跟随用户当前编辑结果；识别 warning、置信度和其他 sourceDraft 证据只用于诊断筛选，不能污染普通文本检索。
export function buildDraftSearchText(formData: SubscriptionFormState): string {
  return [
    formData.name,
    formData.category,
    formData.paymentMethod,
    formData.website,
    formData.notes,
    ...formData.tags,
  ].filter(Boolean).join(" ").toLowerCase();
}

// AI provider 可能返回前端 Intl 尚不支持的币种代码；展示失败时保留原值，避免误改导入 payload。
export function formatDraftPrice(formData: SubscriptionFormState, locale: Locale, unknownLabel: string): string {
  if (!formData.price || !formData.currency) return unknownLabel;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: formData.currency,
      maximumFractionDigits: 2,
    }).format(moneyToNumber(formData.price));
  } catch {
    return `${formData.price} ${formData.currency}`;
  }
}
