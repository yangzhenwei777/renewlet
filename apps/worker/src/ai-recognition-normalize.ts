/**
 * Worker AI 输出归一化层。
 *
 * 第三方模型输出先经过 generated schema，再在这里收敛到 shared RecognizeResponse；任何字段进入导入预览前都必须经过这层。
 */
import {
  AI_RECOGNITION_MAX_SUBSCRIPTIONS,
  aiRecognizePayloadSchema,
  type AiGeneratedRecognizeObject,
  type AiGeneratedSubscriptionDraft,
  type AiRecognizedSubscriptionDraft,
  type AiRecognitionDiagnostics,
  type AiRecognitionSettings,
  type AiRecognizeResponse,
} from "@renewlet/shared/schemas/ai-recognition";
import {
  type AIRecognitionPromptConfigContext,
  type AIRecognitionPromptConfigOption,
} from "@renewlet/shared/ai-recognition-prompt";
import { normalizeAIRecognitionUsefulNotes } from "@renewlet/shared/ai-recognition-notes";
import { customConfigSchema, type ApiCustomConfig } from "@renewlet/shared/schemas/custom-config";
import { moneyFromNumber } from "@renewlet/shared/money";
import {
  BILLING_CYCLES,
  CUSTOM_CYCLE_UNITS,
  DISABLED_REMINDER_DAYS,
  MAX_REMINDER_DAYS,
  REPEAT_REMINDER_INTERVALS,
  REPEAT_REMINDER_WINDOWS,
  SUBSCRIPTION_STATUSES,
  isValidDateOnly,
} from "@renewlet/shared/runtime";
import { serverFormat, serverText, type AppLocale } from "./server-i18n";

const BILLING_CYCLE_SET = new Set<string>(BILLING_CYCLES);
const CUSTOM_CYCLE_UNIT_SET = new Set<string>(CUSTOM_CYCLE_UNITS);
const STATUS_SET = new Set<string>(SUBSCRIPTION_STATUSES);
const REPEAT_REMINDER_INTERVAL_SET = new Set<string>(REPEAT_REMINDER_INTERVALS);
const REPEAT_REMINDER_WINDOW_SET = new Set<string>(REPEAT_REMINDER_WINDOWS);

export function normalizeGeneratedAIRecognizeObject(
  raw: AiGeneratedRecognizeObject,
  providerType: AiRecognitionSettings["providerType"],
  transportProtocol: AiRecognitionSettings["transportProtocol"],
  model: string,
  diagnostics: AiRecognitionDiagnostics,
  configContext: AIRecognitionPromptConfigContext,
): AiRecognizeResponse {
  const warnings = compactAIWarnings(raw.warnings, 20);
  const subscriptions: AiRecognizedSubscriptionDraft[] = [];
  for (const draft of raw.subscriptions.slice(0, AI_RECOGNITION_MAX_SUBSCRIPTIONS)) {
    const normalized = normalizeGeneratedSubscriptionDraft(draft, configContext);
    if (normalized) {
      subscriptions.push(normalized);
    } else {
      warnings.push("AI_WARNING_EMPTY_SUBSCRIPTION_SKIPPED");
    }
  }
  return aiRecognizePayloadSchema.parse({
    providerType,
    transportProtocol,
    model,
    subscriptions,
    warnings: compactAIWarnings(warnings, 20),
    diagnostics,
  });
}

function normalizeGeneratedSubscriptionDraft(
  draft: AiGeneratedSubscriptionDraft,
  configContext: AIRecognitionPromptConfigContext,
): AiRecognizedSubscriptionDraft | null {
  const name = trimMax(draft.name, 120);
  if (!name) return null;
  const warnings = compactAIWarnings(draft.warnings, 12);
  const website = normalizeGeneratedSuggestedField(draft.website);
  const notes = normalizeGeneratedNotesField(draft.notes);
  const confidence = draft.confidence === "high" ? "high" : "low";
  return {
    name,
    price: normalizeGeneratedPrice(draft.price, warnings),
    currency: normalizeGeneratedCurrency(draft.currency, warnings),
    billingCycle: normalizeGeneratedBillingCycle(draft.billingCycle, warnings),
    customDays: normalizeGeneratedPositiveInteger(draft.customDays, MAX_REMINDER_DAYS, "AI_WARNING_CUSTOM_DAYS_INVALID", warnings),
    customCycleUnit: normalizeGeneratedEnum(draft.customCycleUnit, CUSTOM_CYCLE_UNIT_SET, "AI_WARNING_CUSTOM_CYCLE_UNIT_INVALID", warnings),
    oneTimeTermCount: normalizeGeneratedPositiveInteger(draft.oneTimeTermCount, MAX_REMINDER_DAYS, "AI_WARNING_ONE_TIME_TERM_COUNT_INVALID", warnings),
    oneTimeTermUnit: normalizeGeneratedEnum(draft.oneTimeTermUnit, CUSTOM_CYCLE_UNIT_SET, "AI_WARNING_ONE_TIME_TERM_UNIT_INVALID", warnings),
    category: normalizeGeneratedConfigValue(draft.category, configContext.categories),
    status: normalizeGeneratedEnum(draft.status, STATUS_SET, "AI_WARNING_STATUS_INVALID", warnings),
    paymentMethod: normalizeGeneratedConfigValue(draft.paymentMethod, configContext.paymentMethods),
    startDate: normalizeGeneratedDate(draft.startDate, "startDate", warnings),
    nextBillingDate: normalizeGeneratedDate(draft.nextBillingDate, "nextBillingDate", warnings),
    autoCalculateNextBillingDate: draft.autoCalculateNextBillingDate ?? null,
    trialEndDate: normalizeGeneratedDate(draft.trialEndDate, "trialEndDate", warnings),
    website,
    notes,
    tags: normalizeGeneratedTags(draft.tags, draft.name, configContext.tags),
    reminderDays: normalizeGeneratedReminderDays(draft.reminderDays, warnings),
    repeatReminderEnabled: draft.repeatReminderEnabled ?? null,
    repeatReminderInterval: normalizeGeneratedEnum(draft.repeatReminderInterval, REPEAT_REMINDER_INTERVAL_SET, "AI_WARNING_REPEAT_INTERVAL_INVALID", warnings),
    repeatReminderWindow: normalizeGeneratedEnum(draft.repeatReminderWindow, REPEAT_REMINDER_WINDOW_SET, "AI_WARNING_REPEAT_WINDOW_INVALID", warnings),
    confidence,
    warnings: compactAIWarnings(warnings, 12),
  };
}

export function missingDescribableNoteNames(subscriptions: readonly AiRecognizedSubscriptionDraft[]): string[] {
  return subscriptions
    .filter((draft) => !draft.notes && isDescribableForAINotes(draft))
    .map((draft) => draft.name)
    .slice(0, 20);
}

function isDescribableForAINotes(draft: AiRecognizedSubscriptionDraft): boolean {
  return Boolean(draft.website || draft.category || draft.tags.length > 0 || draft.confidence === "high");
}

export function fillMissingNotesWithDynamicFallback(
  response: AiRecognizeResponse,
  locale: AppLocale,
  configContext: AIRecognitionPromptConfigContext,
): AiRecognizeResponse {
  // fallback note 只能使用模型已给出的稳定字段，不能引入 Worker 本地品牌知识，保持 Docker/Worker 草稿一致。
  const subscriptions = response.subscriptions.map((draft) => {
    if (draft.notes || !isDescribableForAINotes(draft)) return draft;
    const note = buildDynamicFallbackNote(draft, locale, configContext);
    if (!note) return draft;
    return {
      ...draft,
      notes: { value: note, source: "suggested" as const },
      warnings: compactAIWarnings(draft.warnings.filter((warning) => warning !== "AI_WARNING_NOTES_MISSING"), 12),
    };
  });
  return aiRecognizePayloadSchema.parse({ ...response, subscriptions });
}

function buildDynamicFallbackNote(
  draft: AiRecognizedSubscriptionDraft,
  locale: AppLocale,
  configContext: AIRecognitionPromptConfigContext,
): string | null {
  const labels = dynamicNoteLabels(draft, configContext);
  const rawNote = labels.length > 0
    ? serverFormat(locale, "aiRecognition.fallbackNote.labels", {
      name: draft.name,
      labels: labels.join(serverText(locale, "aiRecognition.fallbackNote.labelSeparator")),
    })
    : dynamicWebsiteFallbackNote(draft, locale);
  return normalizeAIRecognitionUsefulNotes(rawNote);
}

function dynamicNoteLabels(
  draft: AiRecognizedSubscriptionDraft,
  configContext: AIRecognitionPromptConfigContext,
): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | null | undefined) => {
    const label = trimMax(value ?? "", 80);
    const key = configMatchKey(label);
    if (!label || !key || key === configMatchKey(draft.name) || seen.has(key)) return;
    seen.add(key);
    labels.push(label);
  };
  for (const tag of draft.tags) add(tag);
  if (draft.category) {
    const category = configContext.categories.find((option) => option.value === draft.category) ?? findAIRecognitionConfigOption(configContext.categories, draft.category);
    add(category?.label ?? draft.category);
  }
  return labels.slice(0, 3);
}

function dynamicWebsiteFallbackNote(draft: AiRecognizedSubscriptionDraft, locale: AppLocale): string | null {
  const domain = draft.website ? hostnameFromUrl(draft.website.value) : null;
  if (!domain) return null;
  return serverFormat(locale, "aiRecognition.fallbackNote.website", { name: draft.name, domain });
}

function hostnameFromUrl(value: string): string | null {
  try {
    const url = new URL(value.startsWith("http://") || value.startsWith("https://") ? value : `https://${value}`);
    return url.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function normalizeGeneratedPrice(value: AiGeneratedSubscriptionDraft["price"], warnings: string[]): string | null {
  const parsed = parseGeneratedNumber(value);
  if (parsed === null) return null;
  if (parsed < 0 || parsed > 1_000_000_000) {
    warnings.push("AI_WARNING_PRICE_INVALID");
    return null;
  }
  return moneyFromNumber(parsed);
}

function normalizeGeneratedCurrency(value: string | null | undefined, warnings: string[]): string | null {
  const text = stringValue(value).toUpperCase();
  if (!text) return null;
  const mapped = text === "元" || text === "人民币" || text === "RMB" || text === "YUAN" || text === "￥" || text === "¥"
    ? "CNY"
    : text;
  if (/^[A-Z]{3}$/.test(mapped)) return mapped;
  warnings.push("AI_WARNING_CURRENCY_INVALID");
  return null;
}

function normalizeGeneratedBillingCycle(value: string | null | undefined, warnings: string[]): AiRecognizedSubscriptionDraft["billingCycle"] {
  const text = stringValue(value).toLowerCase();
  if (!text) return null;
  if (BILLING_CYCLE_SET.has(text)) return text as AiRecognizedSubscriptionDraft["billingCycle"];
  const compact = text.replace(/\s+/g, "");
  const mapped = compact.includes("week") || compact.includes("周") ? "weekly"
    : compact.includes("quarter") || compact.includes("季") ? "quarterly"
      : compact.includes("semi") || compact.includes("half") || compact.includes("半年") ? "semi-annual"
        : compact.includes("year") || compact.includes("annual") || compact.includes("年") ? "annual"
          : compact.includes("month") || compact.includes("月") ? "monthly"
            : compact.includes("one-time") || compact.includes("lifetime") || compact.includes("一次") || compact.includes("买断") ? "one-time"
              : null;
  if (mapped) return mapped as AiRecognizedSubscriptionDraft["billingCycle"];
  warnings.push("AI_WARNING_BILLING_CYCLE_INVALID");
  return null;
}

function normalizeGeneratedPositiveInteger(
  value: AiGeneratedSubscriptionDraft["customDays"],
  max: number,
  warning: string,
  warnings: string[],
): number | null {
  const parsed = parseGeneratedInteger(value);
  if (parsed === null) return null;
  if (parsed <= 0 || parsed > max) {
    warnings.push(warning);
    return null;
  }
  return parsed;
}

function normalizeGeneratedReminderDays(value: AiGeneratedSubscriptionDraft["reminderDays"], warnings: string[]): number | null {
  const parsed = parseGeneratedInteger(value);
  if (parsed === null) return null;
  if (parsed < DISABLED_REMINDER_DAYS || parsed > MAX_REMINDER_DAYS) {
    warnings.push("AI_WARNING_REMINDER_DAYS_INVALID");
    return null;
  }
  return parsed;
}

function normalizeGeneratedEnum<T extends string>(
  value: string | null | undefined,
  allowed: Set<string>,
  warning: string,
  warnings: string[],
): T | null {
  const text = stringValue(value);
  if (!text) return null;
  if (allowed.has(text)) return text as T;
  warnings.push(warning);
  return null;
}

function normalizeGeneratedOptionalText(value: string | null | undefined, maxLength: number): string | null {
  return trimMax(stringValue(value), maxLength) || null;
}

function normalizeGeneratedConfigValue(
  value: string | null | undefined,
  options: readonly AIRecognitionPromptConfigOption[],
): string | null {
  const text = normalizeGeneratedOptionalText(value, 80);
  if (!text) return null;
  const matched = findAIRecognitionConfigOption(options, text);
  return matched?.value ?? text;
}

function normalizeGeneratedDate(value: string | null | undefined, field: string, warnings: string[]): string | null {
  const text = stringValue(value);
  if (!text) return null;
  if (isValidDateOnly(text)) return text;
  warnings.push(`AI_WARNING_DATE_INVALID:${field}`);
  return null;
}

function normalizeGeneratedSuggestedField(value: AiGeneratedSubscriptionDraft["website"]): AiRecognizedSubscriptionDraft["website"] {
  if (!value) return null;
  const text = trimMax(value.value ?? "", 5000);
  if (!text) return null;
  return { value: text, source: value.source === "input" ? "input" : "suggested" };
}

function normalizeGeneratedNotesField(value: AiGeneratedSubscriptionDraft["notes"]): AiRecognizedSubscriptionDraft["notes"] {
  if (!value || value.source === "none") return null;
  const text = normalizeAIRecognitionUsefulNotes(value.value);
  if (!text) return null;
  return { value: text, source: value.source === "input" ? "input" : "suggested" };
}

function normalizeGeneratedTags(tags: readonly string[], subscriptionName: string, existingTags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const existing = existingTagMap(existingTags);
  const serviceKey = tagMatchKey(subscriptionName);
  for (const tag of tags) {
    const value = trimMax(tag, 40);
    const key = tagMatchKey(value);
    if (!value || seen.has(key)) continue;
    const existingValue = existing.get(key);
    const nextValue = existingValue ?? value;
    if (!existingValue && !isUsefulGeneratedTag(value, key, serviceKey)) continue;
    // AI 生成标签只允许稳定复用维度；价格、套餐、机房等一次性属性不能污染用户长期筛选。
    seen.add(key);
    out.push(nextValue);
    if (out.length >= 3) break;
  }
  return out;
}

function existingTagMap(tags: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const tag of tags) {
    const value = trimMax(tag, 40);
    const key = tagMatchKey(value);
    if (key && !out.has(key)) out.set(key, value);
  }
  return out;
}

function tagMatchKey(value: string): string {
  return configMatchKey(value);
}

function isUsefulGeneratedTag(value: string, key: string, serviceKey: string): boolean {
  if (!key || (serviceKey && key === serviceKey)) return false;
  const length = [...value.trim()].length;
  const lower = value.trim().toLowerCase();
  if (length < 2 || length > 20) return false;
  if (lower.includes("://") || lower.startsWith("www.") || ["#", "(", ")", "（", "）", "[", "]", "【", "】", "/", "\\", "|", ":", "："].some((separator) => value.includes(separator))) return false;
  if (/\p{Number}/u.test(value) || looksLikeBillingTag(lower) || looksLikeOrderAttributeTag(lower)) return false;
  if (isShortHanTag(value)) return false;
  return true;
}

function looksLikeBillingTag(value: string): boolean {
  return ["usd", "cny", "rmb", "eur", "gbp", "jpy", "¥", "￥", "$", "月", "年", "weekly", "monthly", "annual", "账单", "价格", "付款", "支付", "扣费", "续费"]
    .some((fragment) => value.includes(fragment));
}

function looksLikeOrderAttributeTag(value: string): boolean {
  return ["special", "promo", "promotion", "plan", "套餐", "促销", "机房", "节点", "区域", "地区", "线路", "location", "region", "datacenter"]
    .some((fragment) => value.includes(fragment));
}

function isShortHanTag(value: string): boolean {
  const chars = [...value.trim()];
  return chars.length > 0 && chars.length <= 2 && chars.every((char) => /\p{Script=Han}/u.test(char));
}

function parseGeneratedNumber(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const text = stringValue(value).replace(/,/g, "");
  const match = /-?\d+(?:\.\d+)?/.exec(text);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseGeneratedInteger(value: number | string | null | undefined): number | null {
  const parsed = parseGeneratedNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function compactAIWarnings(warnings: readonly string[], maxCount: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const warning of warnings) {
    const value = trimMax(warning, 240);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= maxCount) break;
  }
  return out;
}

function trimMax(value: string, maxLength: number): string {
  return [...value.trim()].slice(0, maxLength).join("");
}

function stringValue(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function aiRecognitionConfigContext(rawConfig: unknown, locale: AppLocale, tags: readonly string[] = []): AIRecognitionPromptConfigContext {
  const parsed = customConfigSchema.safeParse(rawConfig);
  const config = parsed.success ? parsed.data : { categories: [], paymentMethods: [], statuses: [], currencies: [] };
  return {
    categories: config.categories.map((item) => aiRecognitionConfigOption(item, locale)),
    paymentMethods: config.paymentMethods.map((item) => aiRecognitionConfigOption(item, locale)),
    tags,
  };
}

function aiRecognitionConfigOption(
  item: ApiCustomConfig["categories"][number],
  locale: AppLocale,
): AIRecognitionPromptConfigOption {
  return {
    value: item.value,
    label: locale === "en-US" ? item.labels["en-US"] : item.labels["zh-CN"],
    zhCN: item.labels["zh-CN"],
    enUS: item.labels["en-US"],
  };
}

function findAIRecognitionConfigOption(
  options: readonly AIRecognitionPromptConfigOption[],
  text: string,
): AIRecognitionPromptConfigOption | null {
  const key = configMatchKey(text);
  if (!key) return null;
  return options.find((option) => (
    configMatchKey(option.value) === key
    || configMatchKey(option.label) === key
    || configMatchKey(option.zhCN) === key
    || configMatchKey(option.enUS) === key
  )) ?? null;
}

function configMatchKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-—–/\\|&+，,、.。:：()（）[\]【】]+/g, "");
}
