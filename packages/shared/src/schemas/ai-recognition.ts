/**
 * AI 识别 schema 是 Go、Cloudflare Worker 和前端导入工作台的共同契约。
 *
 * 识别结果只生成临时草稿和 diagnostics，不直接写 subscriptions；SSE 中只有 `recognition/final`
 * 可以进入导入 preview/apply，progress/partial/delta 事件只服务用户感知和排查。
 */
import { z } from "zod";
import {
  BILLING_CYCLES,
  CUSTOM_CYCLE_UNITS,
  DISABLED_REMINDER_DAYS,
  MAX_REMINDER_DAYS,
  REPEAT_REMINDER_INTERVALS,
  REPEAT_REMINDER_WINDOWS,
  SUBSCRIPTION_STATUSES,
  isValidDateOnly,
} from "../runtime";
import {
  UPSTREAM_RAW_RESPONSE_TEXT_MAX_CHARS,
  upstreamErrorDetailsSchema,
} from "./upstream";
import { apiSuccessResponseSchema } from "./api";
import { moneyStringSchema } from "../money";
import { secretMutationSchema } from "./secrets";

export const AI_RECOGNITION_MAX_TEXT_CHARS = 30_000;
export const AI_RECOGNITION_MAX_IMAGES = 5;
export const AI_RECOGNITION_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const AI_RECOGNITION_MAX_SUBSCRIPTIONS = 100;
export const AI_RECOGNITION_DIAGNOSTIC_TEXT_MAX_CHARS = 32_000;
export const AI_RECOGNITION_DIAGNOSTIC_JSON_MAX_CHARS = 32_000;
export const AI_RECOGNITION_MAX_MODEL_LIST_MODELS = 300;
export const AI_PROVIDER_RESPONSE_BODY_MAX_CHARS = UPSTREAM_RAW_RESPONSE_TEXT_MAX_CHARS;

/** Provider 类型是用户设置的存储值；transport protocol 必须由 provider canonical 派生，不能让历史字段反向影响运行时。 */
export const aiRecognitionProviderTypeSchema = z.enum(["openai", "anthropic", "gemini", "openai-compatible"]);
export type AiRecognitionProviderType = z.infer<typeof aiRecognitionProviderTypeSchema>;
export const aiRecognitionTransportProtocolSchema = z.enum(["openai-chat", "anthropic-messages", "gemini-generate-content"]);
export type AiRecognitionTransportProtocol = z.infer<typeof aiRecognitionTransportProtocolSchema>;
export const aiRecognitionModelInputModeSchema = z.enum(["select", "manual"]);
export type AiRecognitionModelInputMode = z.infer<typeof aiRecognitionModelInputModeSchema>;

export const openaiReasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
export const geminiThinkingLevelSchema = z.enum(["minimal", "low", "medium", "high"]);
export const anthropicThinkingEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const openaiThinkingControlSchema = z.object({
  provider: z.literal("openai"),
  effort: openaiReasoningEffortSchema,
}).strict();

export const geminiThinkingControlSchema = z.discriminatedUnion("mode", [
  z.object({
    provider: z.literal("gemini"),
    mode: z.literal("off"),
  }).strict(),
  z.object({
    provider: z.literal("gemini"),
    mode: z.literal("dynamic"),
  }).strict(),
  z.object({
    provider: z.literal("gemini"),
    mode: z.literal("budget"),
    budget: z.number().int().min(1).max(32_768),
  }).strict(),
  z.object({
    provider: z.literal("gemini"),
    mode: z.literal("level"),
    level: geminiThinkingLevelSchema,
  }).strict(),
]);

export const anthropicThinkingControlSchema = z.discriminatedUnion("mode", [
  z.object({
    provider: z.literal("anthropic"),
    mode: z.literal("effort"),
    effort: anthropicThinkingEffortSchema,
  }).strict(),
  z.object({
    provider: z.literal("anthropic"),
    mode: z.literal("budget"),
    budgetTokens: z.number().int().min(1024).max(64_000),
  }).strict(),
]);

export const aiThinkingControlSchema = z.union([
  openaiThinkingControlSchema,
  geminiThinkingControlSchema,
  anthropicThinkingControlSchema,
]);
export type AiThinkingControl = z.infer<typeof aiThinkingControlSchema>;

const optionalProviderBaseUrlSchema = z.string().trim().max(2048).refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}, "AI base URL must be empty or an http(s) URL without credentials");

/** canonical transport 是 SDK 分派事实源；OpenAI-compatible 在 Renewlet 内固定走 OpenAI Chat 形状。 */
export function canonicalAIRecognitionTransportProtocol(providerType: AiRecognitionProviderType): AiRecognitionTransportProtocol {
  if (providerType === "anthropic") return "anthropic-messages";
  if (providerType === "gemini") return "gemini-generate-content";
  return "openai-chat";
}

function normalizeAIRecognitionSettingsInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const providerType = typeof input["providerType"] === "string"
    ? input["providerType"]
    : typeof input["provider"] === "string"
      ? input["provider"]
      : undefined;
  const normalized = { ...input };
  delete normalized["provider"];
  const parsedProviderType = providerType
    ? aiRecognitionProviderTypeSchema.safeParse(providerType)
    : null;
  if (parsedProviderType?.success && !normalized["providerType"]) {
    normalized["providerType"] = parsedProviderType.data;
  }
  const normalizedProviderType = normalized["providerType"];
  const parsedNormalizedProviderType = typeof normalizedProviderType === "string"
    ? aiRecognitionProviderTypeSchema.safeParse(normalizedProviderType)
    : null;
  if (parsedNormalizedProviderType?.success) {
    normalized["transportProtocol"] = canonicalAIRecognitionTransportProtocol(parsedNormalizedProviderType.data);
  }
  return normalized;
}

function aiThinkingControlMatchesProviderType(providerType: AiRecognitionProviderType, control: AiThinkingControl | null): boolean {
  if (control === null) return true;
  if (providerType === "openai-compatible") return false;
  return control.provider === providerType;
}

const aiRecognitionPublicSettingsShape = {
  providerType: aiRecognitionProviderTypeSchema,
  transportProtocol: aiRecognitionTransportProtocolSchema,
  model: z.string().trim().max(160),
  modelInputMode: aiRecognitionModelInputModeSchema.default("select"),
  baseUrl: optionalProviderBaseUrlSchema,
  defaultThinkingControl: aiThinkingControlSchema.nullable(),
};

export const aiRecognitionPublicSettingsSchema = z.object(aiRecognitionPublicSettingsShape).strict();
export type AiRecognitionPublicSettings = z.infer<typeof aiRecognitionPublicSettingsSchema>;

const aiRecognitionSettingsBaseSchema = z.object({
  ...aiRecognitionPublicSettingsShape,
  apiKey: z.string().trim().max(4096),
}).strict().transform((settings) => ({
  ...settings,
  transportProtocol: canonicalAIRecognitionTransportProtocol(settings.providerType),
  // thinking control 是 provider 私有协议，切换 provider 时清空错配值，避免把旧设置发给新模型。
  defaultThinkingControl: aiThinkingControlMatchesProviderType(settings.providerType, settings.defaultThinkingControl)
    ? settings.defaultThinkingControl
    : null,
}));
export const aiRecognitionSettingsSchema = z.preprocess(normalizeAIRecognitionSettingsInput, aiRecognitionSettingsBaseSchema);
export type AiRecognitionSettings = z.infer<typeof aiRecognitionSettingsSchema>;

const aiRecognitionDiagnosticTextSchema = z.object({
  value: z.string().max(AI_RECOGNITION_DIAGNOSTIC_TEXT_MAX_CHARS),
  truncated: z.boolean(),
}).strict();
export type AiRecognitionDiagnosticText = z.infer<typeof aiRecognitionDiagnosticTextSchema>;

export const aiRecognitionDiagnosticsSchema = z.object({
  schemaVersion: z.literal("1"),
  promptVersion: z.string().trim().min(1).max(80),
  schemaName: z.string().trim().min(1).max(120),
  prompt: z.object({
    system: aiRecognitionDiagnosticTextSchema,
    user: aiRecognitionDiagnosticTextSchema,
  }).strict(),
  output: z.object({
    rawModelText: aiRecognitionDiagnosticTextSchema.nullable(),
    rawObjectJson: aiRecognitionDiagnosticTextSchema.nullable(),
  }).strict(),
  request: z.object({
    providerType: aiRecognitionProviderTypeSchema,
    transportProtocol: aiRecognitionTransportProtocolSchema,
    model: z.string().trim().min(1).max(160),
    thinkingControl: aiThinkingControlSchema.nullable(),
    maxOutputTokens: z.number().int().positive().max(128_000),
    textCharCount: z.number().int().nonnegative().max(AI_RECOGNITION_MAX_TEXT_CHARS),
    images: z.array(z.object({
      mediaType: z.string().trim().min(1).max(80),
      sizeBytes: z.number().int().nonnegative().max(AI_RECOGNITION_MAX_IMAGE_BYTES),
    }).strict()).max(AI_RECOGNITION_MAX_IMAGES),
  }).strict(),
  response: z.object({
    usage: z.unknown().nullable(),
    finishReason: z.string().trim().max(120).nullable(),
    providerMetadata: z.unknown().nullable(),
  }).strict(),
}).strict();
export type AiRecognitionDiagnostics = z.infer<typeof aiRecognitionDiagnosticsSchema>;

export const aiRecognitionErrorDetailsSchema = upstreamErrorDetailsSchema;
export type AiRecognitionErrorDetails = z.infer<typeof aiRecognitionErrorDetailsSchema>;

const dateOnlyNullableSchema = z.string().refine(isValidDateOnly, "Invalid date").nullable();
const suggestedFieldSourceSchema = z.enum(["input", "suggested"]);
const generatedNotesSourceSchema = z.enum(["input", "suggested", "none"]);
const suggestedTextFieldSchema = z.object({
  value: z.string().trim().max(5000),
  source: suggestedFieldSourceSchema,
}).strict();
const generatedNumberSchema = z.union([z.number().finite(), z.string().trim().max(80)]).nullable();
const generatedIntegerSchema = z.union([z.number().int(), z.string().trim().max(80)]).nullable();
const generatedTextSchema = z.string().trim().max(5000).nullable();
const generatedWebsiteFieldSchema = z.object({
  value: z.string().trim().max(5000).nullable(),
  source: suggestedFieldSourceSchema,
}).strict().nullable().describe("Official or user-provided website for the subscribed service. Use null for the entire website field when the official site is ambiguous or unknown.");
const generatedNotesFieldSchema = z.object({
  value: z.string().trim().max(5000).nullable().describe("Concise neutral service/site description. Must be non-null for describable services; not a category, import advice, confirmation reminder, or AI process note."),
  source: generatedNotesSourceSchema,
}).strict().describe("Required service/site description decision object. Use value=null and source=none only when the service purpose is truly unknowable from input, domain, service name, category, tags, or high-confidence public knowledge.");
const generatedTagsSchema = z.array(z.string().trim().max(40))
  .max(3)
  .describe("User-facing reusable organization tags. Prefer existing user tags from prompt context; if none fit, generate only stable reusable service/product/domain tags, not one-off order attributes.");
const generatedCategorySchema = z.string().trim().max(80).nullable()
  .describe("Renewlet category value from provided options when possible; otherwise a concise user-facing category only when the service type is obvious.");
const generatedPaymentMethodSchema = z.string().trim().max(80).nullable()
  .describe("Renewlet payment method value from provided options when possible; otherwise a concise user-facing payment method only when the input explicitly names one.");
const generatedConfidenceSchema = z.enum(["high", "low"])
  .describe("Use high only when the extracted row can be directly confirmed; use low for ambiguous, partial, or inferred records.");
const generatedWarningsSchema = z.array(z.string().trim().min(1).max(240))
  .max(12)
  .describe("Stable warning codes for uncertain or invalid fields; keep uncertainty out of notes.");

export const aiRecognizedSubscriptionDraftSchema = z.object({
  name: z.string().trim().min(1).max(120),
  price: moneyStringSchema.nullable(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).nullable(),
  billingCycle: z.enum(BILLING_CYCLES).nullable(),
  customDays: z.number().int().positive().nullable(),
  customCycleUnit: z.enum(CUSTOM_CYCLE_UNITS).nullable(),
  oneTimeTermCount: z.number().int().positive().max(MAX_REMINDER_DAYS).nullable(),
  oneTimeTermUnit: z.enum(CUSTOM_CYCLE_UNITS).nullable(),
  category: z.string().trim().min(1).max(80).nullable(),
  status: z.enum(SUBSCRIPTION_STATUSES).nullable(),
  paymentMethod: z.string().trim().min(1).max(80).nullable(),
  startDate: dateOnlyNullableSchema,
  nextBillingDate: dateOnlyNullableSchema,
  autoCalculateNextBillingDate: z.boolean().nullable(),
  trialEndDate: dateOnlyNullableSchema,
  website: suggestedTextFieldSchema.nullable(),
  notes: suggestedTextFieldSchema.nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).max(100),
  reminderDays: z.number().int().min(DISABLED_REMINDER_DAYS).max(MAX_REMINDER_DAYS).nullable(),
  repeatReminderEnabled: z.boolean().nullable(),
  repeatReminderInterval: z.enum(REPEAT_REMINDER_INTERVALS).nullable(),
  repeatReminderWindow: z.enum(REPEAT_REMINDER_WINDOWS).nullable(),
  confidence: z.enum(["high", "low"]),
  warnings: z.array(z.string().trim().min(1).max(240)).max(12),
}).strict();
export type AiRecognizedSubscriptionDraft = z.infer<typeof aiRecognizedSubscriptionDraftSchema>;

/** 识别 JSON 响应是非流式和 SSE final 共享的最终事实源。 */
export const aiRecognizePayloadSchema = z.object({
  providerType: aiRecognitionProviderTypeSchema,
  transportProtocol: aiRecognitionTransportProtocolSchema,
  model: z.string().trim().min(1).max(160),
  subscriptions: z.array(aiRecognizedSubscriptionDraftSchema).max(AI_RECOGNITION_MAX_SUBSCRIPTIONS),
  warnings: z.array(z.string().trim().min(1).max(240)).max(20),
  diagnostics: aiRecognitionDiagnosticsSchema,
}).strict();
export const aiRecognizeResponseSchema = apiSuccessResponseSchema(aiRecognizePayloadSchema);
export type AiRecognizeResponse = z.infer<typeof aiRecognizePayloadSchema>;

/** 流式识别事件只暴露 UI 状态和最终响应；partial/delta 不能被前端当成可导入草稿。 */
export const aiRecognitionStreamStageSchema = z.enum([
  "input-read",
  "model-start",
  "model-stream",
  "repair-start",
  "validating",
  "finalizing",
]);
export type AiRecognitionStreamStage = z.infer<typeof aiRecognitionStreamStageSchema>;

const aiRecognitionStreamProgressEventSchema = z.object({
  type: z.literal("recognition/progress"),
  stage: aiRecognitionStreamStageSchema,
}).strict();

const aiRecognitionStreamPartialEventSchema = z.object({
  type: z.literal("recognition/partial"),
  subscriptionsSeen: z.number().int().nonnegative().max(AI_RECOGNITION_MAX_SUBSCRIPTIONS),
  warningsSeen: z.number().int().nonnegative().max(20),
}).strict();

const aiRecognitionStreamTextDeltaEventSchema = z.object({
  type: z.literal("recognition/text-delta"),
  delta: z.string().max(AI_RECOGNITION_DIAGNOSTIC_TEXT_MAX_CHARS),
}).strict();

const aiRecognitionStreamReasoningDeltaEventSchema = z.object({
  type: z.literal("recognition/reasoning-delta"),
  delta: z.string().max(AI_RECOGNITION_DIAGNOSTIC_TEXT_MAX_CHARS),
}).strict();

const aiRecognitionStreamFinalEventSchema = z.object({
  type: z.literal("recognition/final"),
  response: aiRecognizePayloadSchema,
}).strict();

const aiRecognitionStreamErrorEventSchema = z.object({
  type: z.literal("recognition/error"),
  message: z.string().trim().min(1).max(1000),
  code: z.string().trim().min(1).max(120),
  details: aiRecognitionErrorDetailsSchema.optional(),
}).strict();

export const aiRecognitionStreamEventSchema = z.discriminatedUnion("type", [
  aiRecognitionStreamProgressEventSchema,
  aiRecognitionStreamPartialEventSchema,
  aiRecognitionStreamTextDeltaEventSchema,
  aiRecognitionStreamReasoningDeltaEventSchema,
  aiRecognitionStreamFinalEventSchema,
  aiRecognitionStreamErrorEventSchema,
]);
export type AiRecognitionStreamEvent = z.infer<typeof aiRecognitionStreamEventSchema>;

/** 模型原始输出 schema 故意更宽，归一化层负责把字符串数字、模糊日期和 null 收敛为导入草稿。 */
export const aiGeneratedSubscriptionDraftSchema = z.object({
  name: z.string().trim().max(120),
  price: generatedNumberSchema,
  currency: z.string().trim().max(40).nullable(),
  billingCycle: z.string().trim().max(80).nullable(),
  customDays: generatedIntegerSchema,
  customCycleUnit: z.string().trim().max(40).nullable(),
  oneTimeTermCount: generatedIntegerSchema,
  oneTimeTermUnit: z.string().trim().max(40).nullable(),
  category: generatedCategorySchema,
  status: z.string().trim().max(40).nullable(),
  paymentMethod: generatedPaymentMethodSchema,
  startDate: generatedTextSchema,
  nextBillingDate: generatedTextSchema,
  autoCalculateNextBillingDate: z.boolean().nullable(),
  trialEndDate: generatedTextSchema,
  website: generatedWebsiteFieldSchema,
  notes: generatedNotesFieldSchema,
  tags: generatedTagsSchema,
  reminderDays: generatedIntegerSchema,
  repeatReminderEnabled: z.boolean().nullable(),
  repeatReminderInterval: z.string().trim().max(40).nullable(),
  repeatReminderWindow: z.string().trim().max(40).nullable(),
  confidence: generatedConfidenceSchema,
  warnings: generatedWarningsSchema,
}).strict();
export type AiGeneratedSubscriptionDraft = z.infer<typeof aiGeneratedSubscriptionDraftSchema>;

export const aiGeneratedRecognizeObjectSchema = z.object({
  subscriptions: z.array(aiGeneratedSubscriptionDraftSchema).max(AI_RECOGNITION_MAX_SUBSCRIPTIONS),
  warnings: z.array(z.string().trim().min(1).max(240)).max(20),
}).strict();
export type AiGeneratedRecognizeObject = z.infer<typeof aiGeneratedRecognizeObjectSchema>;

export const aiRecognitionTestRequestSchema = z.object({
  settings: aiRecognitionPublicSettingsSchema,
  apiKey: secretMutationSchema,
}).strict();
export type AiRecognitionTestRequest = z.infer<typeof aiRecognitionTestRequestSchema>;

export const aiRecognitionTestPayloadSchema = z.object({
  providerType: aiRecognitionProviderTypeSchema,
  transportProtocol: aiRecognitionTransportProtocolSchema,
  model: z.string().trim().min(1).max(160),
}).strict();
export const aiRecognitionTestResponseSchema = apiSuccessResponseSchema(aiRecognitionTestPayloadSchema);
export type AiRecognitionTestResponse = z.infer<typeof aiRecognitionTestPayloadSchema>;

/** 模型列表只用于设置页候选展示；候选上限和 capabilities 允许 null，避免 provider 元数据差异拖垮 UI。 */
const aiModelCapabilitySchema = z.object({
  textInput: z.boolean().nullable(),
  imageInput: z.boolean().nullable(),
  structuredOutput: z.boolean().nullable(),
  thinking: z.boolean().nullable(),
}).strict();
export type AiModelCapability = z.infer<typeof aiModelCapabilitySchema>;

export const aiModelListRequestSchema = z.object({
  providerType: aiRecognitionProviderTypeSchema,
  baseUrl: optionalProviderBaseUrlSchema,
  apiKey: secretMutationSchema,
}).strict();
export type AiModelListRequest = z.infer<typeof aiModelListRequestSchema>;

export const aiModelListItemSchema = z.object({
  id: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200).nullable(),
  createdAt: z.string().trim().min(1).max(120).nullable(),
  ownedBy: z.string().trim().min(1).max(120).nullable(),
  inputTokenLimit: z.number().int().positive().max(10_000_000).nullable(),
  outputTokenLimit: z.number().int().positive().max(10_000_000).nullable(),
  capabilities: aiModelCapabilitySchema,
}).strict();
export type AiModelListItem = z.infer<typeof aiModelListItemSchema>;

export const aiModelListPayloadSchema = z.object({
  providerType: aiRecognitionProviderTypeSchema,
  transportProtocol: aiRecognitionTransportProtocolSchema,
  models: z.array(aiModelListItemSchema).max(AI_RECOGNITION_MAX_MODEL_LIST_MODELS),
  truncated: z.boolean(),
}).strict();
export const aiModelListResponseSchema = apiSuccessResponseSchema(aiModelListPayloadSchema);
export type AiModelListResponse = z.infer<typeof aiModelListPayloadSchema>;

export const aiModelListErrorDetailsSchema = upstreamErrorDetailsSchema;
export type AiModelListErrorDetails = z.infer<typeof aiModelListErrorDetailsSchema>;
