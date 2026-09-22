import type { AiRecognizedSubscriptionDraft } from "@/lib/api/schemas/ai-recognition";
import {
  parseNonNegativeIntegerInput,
} from "@/lib/subscription-form";
import { assertDateOnly, type DateOnly } from "@/lib/time/date-only";
import { normalizeWebsite } from "@/modules/import-export/domain/import-export-model";
import type { CustomConfig } from "@/types/config";
import {
  DISABLED_REMINDER_DAYS,
  INHERIT_REMINDER_DAYS,
  REMINDER_DAYS_OPTIONS,
  type AppSettings,
} from "@/types/subscription";
import { createSubscriptionFormState, type SubscriptionFormState } from "@/types/subscription-form";

interface AIDraftFormContext {
  settings: AppSettings;
  config: CustomConfig;
}

export const AI_DRAFT_CONFIRMATION_FIELDS = ["price", "currency", "billingCycle"] as const;
export type AIDraftConfirmationField = typeof AI_DRAFT_CONFIRMATION_FIELDS[number];

// AI 草稿复用订阅表单状态，保证用户确认前走同一套日期、提醒和分类校验，而不是绕过导入链路直写。
export function aiDraftToSubscriptionFormState(
  draft: AiRecognizedSubscriptionDraft,
  context: AIDraftFormContext,
): SubscriptionFormState {
  const isOneTimeBuyout = draft.billingCycle === "one-time" && !draft.oneTimeTermCount;
  // 买断/长期有效没有下一次提醒语义，AI 返回的提醒字段也不能覆盖该业务规则。
  const reminderState = isOneTimeBuyout
    ? disabledReminderState()
    : reminderStateFromDraft(draft, context.settings.notificationReminderDays);
  return createSubscriptionFormState({
    name: draft.name,
    logo: undefined,
    price: draft.price === null ? "" : String(draft.price),
    currency: draft.currency ?? context.settings.defaultCurrency,
    billingCycle: draft.billingCycle ?? "monthly",
    customDays: draft.customDays === null ? "" : String(draft.customDays),
    customCycleUnit: draft.customCycleUnit ?? "day",
    oneTimeMode: isOneTimeBuyout ? "buyout" : "term",
    oneTimeTermCount: draft.oneTimeTermCount === null ? "1" : String(draft.oneTimeTermCount),
    oneTimeTermUnit: draft.oneTimeTermUnit ?? "month",
    category: draft.category ?? context.config.categories[0]?.value ?? "other",
    status: draft.status ?? "active",
    publicHidden: false,
    paymentMethod: draft.paymentMethod ?? "",
    startDate: toFormDate(draft.startDate),
    nextBillingDate: toFormDate(draft.nextBillingDate),
    autoRenew: false,
    autoCalculate: draft.autoCalculateNextBillingDate ?? false,
    reminderType: reminderState.reminderType,
    reminderDays: reminderState.reminderDays,
    customReminderDays: reminderState.customReminderDays,
    repeatReminderEnabled: isOneTimeBuyout || draft.reminderDays === DISABLED_REMINDER_DAYS ? false : draft.repeatReminderEnabled ?? false,
    repeatReminderInterval: draft.repeatReminderInterval ?? "1h",
    repeatReminderWindow: draft.repeatReminderWindow ?? "72h",
    costSharing: undefined,
    website: normalizeWebsite(draft.website?.value, []) ?? draft.website?.value ?? "",
    notes: draft.notes?.value ?? "",
    tags: draft.tags,
  });
}

export function getInitialAIDraftConfirmationFields(
  draft: AiRecognizedSubscriptionDraft,
): AIDraftConfirmationField[] {
  // 缺失字段会先显示可编辑默认值，但“有可用值”不等于“用户认可该值”，因此确认状态必须独立于表单合法性保存。
  return AI_DRAFT_CONFIRMATION_FIELDS.filter((field) => {
    if (field === "price") return draft.price === null;
    if (field === "currency") return !draft.currency?.trim();
    return draft.billingCycle === null;
  });
}

function disabledReminderState(): Pick<SubscriptionFormState, "reminderType" | "reminderDays" | "customReminderDays"> {
  return { reminderType: "disabled", reminderDays: String(DISABLED_REMINDER_DAYS), customReminderDays: "" };
}

function reminderStateFromDraft(
  draft: AiRecognizedSubscriptionDraft,
  defaultReminderDays: number,
): Pick<SubscriptionFormState, "reminderType" | "reminderDays" | "customReminderDays"> {
  const reminderDays = draft.reminderDays ?? INHERIT_REMINDER_DAYS;
  if (reminderDays === DISABLED_REMINDER_DAYS) {
    return disabledReminderState();
  }
  if (reminderDays === INHERIT_REMINDER_DAYS) {
    return { reminderType: "inherit", reminderDays: String(INHERIT_REMINDER_DAYS), customReminderDays: "" };
  }
  if (REMINDER_DAYS_OPTIONS.some((option) => option.value === reminderDays)) {
    return { reminderType: "preset", reminderDays: String(reminderDays), customReminderDays: "" };
  }
  // 非预设提前天数落到 custom 输入，默认选项仍保持全局值，避免隐藏用户自定义提醒窗口。
  return {
    reminderType: "custom",
    reminderDays: String(defaultReminderDays),
    customReminderDays: String(reminderDays),
  };
}

function toFormDate(value: string | null): DateOnly | undefined {
  return value ? assertDateOnly(value) : undefined;
}
