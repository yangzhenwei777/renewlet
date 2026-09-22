import type { Locale } from "@/i18n/locales";
import type { MessageKey, MessageParams } from "@/i18n/messages";
import { parsePositiveIntegerInput } from "@/lib/subscription-form";
import { formatBillingCycleLabel } from "@/lib/subscription-billing";
import type { CostSharing } from "@/types/subscription";
import { INHERIT_REMINDER_DAYS, REMINDER_DAYS_OPTIONS } from "@/types/subscription";
import type { SubscriptionFormState } from "@/types/subscription-form";
import {
  isValidCostSharingCollectionReminderDays,
  type CostSharingCollectionReminder,
} from "@renewlet/shared/cost-sharing";
import { moneyToNumber } from "@renewlet/shared/money";

export type CostSharingFieldUpdater = <K extends keyof SubscriptionFormState>(
  key: K,
  value: SubscriptionFormState[K],
) => void;

export const COLLECTION_REMINDER_CUSTOM_VALUE = "custom";
export const MAX_COST_SHARING_MEMBERS = 20;

export function defaultCostSharing(
  t: (key: MessageKey, values?: MessageParams) => string,
): CostSharing {
  return {
    enabled: true,
    splitMode: "equal",
    members: [
      { id: newCostSharingId(), name: t("subscription.costSharing.memberDefault", { index: 1 }) },
    ],
  };
}

export function defaultCollectionReminder(): CostSharingCollectionReminder {
  return {
    enabled: true,
    reminderDays: INHERIT_REMINDER_DAYS,
  };
}

export function setCostSharing(
  update: CostSharingFieldUpdater,
  next: CostSharing | undefined,
  t: (key: MessageKey, values?: MessageParams) => string,
) {
  update("costSharing", next ? normalizeCostSharingSelection(next, t) : undefined);
}

export function costSharingTotal(formData: SubscriptionFormState): number {
  const price = moneyToNumber(formData.price);
  return Number.isFinite(price) && price >= 0 ? price : 0;
}

export function collectionReminderSelectValue(
  reminder: CostSharingCollectionReminder | undefined,
): string {
  const days = reminder?.reminderDays ?? INHERIT_REMINDER_DAYS;
  if (days === INHERIT_REMINDER_DAYS) return String(INHERIT_REMINDER_DAYS);
  if (REMINDER_DAYS_OPTIONS.some((option) => option.value === days)) return String(days);
  return COLLECTION_REMINDER_CUSTOM_VALUE;
}

export function defaultCustomCollectionReminderDays(): number {
  return 2;
}

export function billingCycleLabelForForm(
  formData: SubscriptionFormState,
  locale: Locale,
): string {
  const customDays = formData.billingCycle === "custom"
    ? parsePositiveIntegerInput(formData.customDays) ?? 1
    : undefined;
  return formatBillingCycleLabel({
    billingCycle: formData.billingCycle,
    customDays,
    customCycleUnit: formData.customCycleUnit,
  }, locale);
}

export function collectionReminderSummaryText(
  t: (key: MessageKey, values?: MessageParams) => string,
  reminder: CostSharingCollectionReminder | undefined,
  notificationReminderDays: number,
  cycleLabel: string,
  allowed = true,
): string {
  if (!allowed) return t("subscription.costSharing.collectionReminderSummaryUnavailableForBuyout");
  if (!reminder?.enabled) return t("subscription.costSharing.collectionReminderSummaryDisabled");
  const leadDays = reminder.reminderDays === INHERIT_REMINDER_DAYS
    || !isValidCostSharingCollectionReminderDays(reminder.reminderDays)
    ? notificationReminderDays
    : reminder.reminderDays;
  return t("subscription.costSharing.collectionReminderSummary", {
    cycle: t("subscription.costSharing.collectionReminderInheritedCycle", { cycle: cycleLabel }),
    anchor: t("subscription.costSharing.collectionReminderAnchorMemberJoined"),
    lead: collectionReminderLeadLabel(t, leadDays),
  });
}

export function newCostSharingId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `member-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeCostSharingSelection(
  costSharing: CostSharing,
  t: (key: MessageKey, values?: MessageParams) => string,
): CostSharing {
  // enabled + 空成员既无法分摊也不符合服务端 schema；在 UI 入口补首位成员，避免产生只能等提交时才发现的中间态。
  const members = costSharing.members.length > 0
    ? costSharing.members
    : [{ id: newCostSharingId(), name: t("subscription.costSharing.memberDefault", { index: 1 }) }];
  return { ...costSharing, members };
}

function collectionReminderLeadLabel(
  t: (key: MessageKey, values?: MessageParams) => string,
  reminderDays: number,
): string {
  return reminderDays === 0
    ? t("subscription.costSharing.collectionReminderLeadToday")
    : t("subscription.costSharing.collectionReminderLeadDays", { days: reminderDays });
}
