import { generateObject, Output, streamText, type JSONValue } from "ai";
import {
  aiGeneratedRecognizeObjectSchema,
  aiRecognitionErrorDetailsSchema,
  aiRecognitionStreamEventSchema,
  type AiGeneratedRecognizeObject,
  type AiRecognitionDiagnostics,
  type AiRecognitionSettings,
  type AiRecognitionStreamEvent,
  type AiRecognitionStreamStage,
  type AiThinkingControl,
  type AiRecognizeResponse,
} from "@renewlet/shared/schemas/ai-recognition";
import { resolveAIProviderEndpoint } from "@renewlet/shared/ai-provider-endpoints";
import {
  AI_RECOGNITION_SCHEMA_NAME,
  buildAIRecognitionRepairUserPrompt,
  buildAIRecognitionSystemPrompt,
  buildAIRecognitionUserPrompt,
  type AIRecognitionPromptConfigContext,
} from "@renewlet/shared/ai-recognition-prompt";
import { HttpError } from "./http";
import { serverText, type AppLocale } from "./server-i18n";
import {
  fillMissingNotesWithDynamicFallback,
  missingDescribableNoteNames,
  normalizeGeneratedAIRecognizeObject,
} from "./ai-recognition-normalize";
import {
  aiRecognitionErrorDetails,
  buildAIRecognitionDiagnostics,
  finishReasonText,
  noObjectGeneratedFinishReason,
  noObjectGeneratedText,
  noObjectGeneratedUsage,
} from "./ai-recognition-diagnostics";
import {
  buildAIRecognitionMessages,
  AI_RECOGNITION_PROVIDER_TIMEOUT_MS,
  createAIRecognitionLanguageModel,
  createAIRecognitionModel,
  providerOptionsForThinking,
  todayDateOnly,
  type AIRecognitionCapture,
} from "./ai-recognition-runtime";
import { providerResponseFromError } from "./ai-provider-response";

type AIRecognitionInput = {
  text: string;
  images: Array<{ data: Uint8Array; mediaType: string }>;
  thinkingControl: AiThinkingControl | null;
};

type AIRecognitionGeneration = AIRecognitionCapture & {
  object: AiGeneratedRecognizeObject;
};

type AIRecognitionStreamSink = {
  emit: (event: AiRecognitionStreamEvent) => void;
};

class AIRecognitionRunError extends Error {
  constructor(
    readonly causeError: unknown,
    readonly diagnostics: AiRecognitionDiagnostics,
  ) {
    super(causeError instanceof Error ? causeError.message : String(causeError));
    this.name = "AIRecognitionRunError";
  }
}

class AIRecognitionGenerationError extends Error {
  constructor(
    readonly causeError: unknown,
    readonly capture: AIRecognitionCapture,
  ) {
    super(causeError instanceof Error ? causeError.message : String(causeError));
    this.name = "AIRecognitionGenerationError";
  }
}

/**
 * 执行非流式 AI 识别并返回结构化导入草稿。
 *
 * 模型输出会经过“生成 -> 原文 JSON 恢复 -> schema repair -> 最终规范化”链路；失败时只返回脱敏 diagnostics。
 */
export async function runAIRecognition({
  settings,
  input,
  locale,
  timezone,
  defaultCurrency,
  configContext,
  thinkingControl,
  maxOutputTokens,
  abortSignal,
}: {
  settings: AiRecognitionSettings;
  input: AIRecognitionInput;
  locale: AppLocale;
  timezone: string;
  defaultCurrency: string;
  configContext: AIRecognitionPromptConfigContext;
  thinkingControl: AiThinkingControl | null;
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
}): Promise<AiRecognizeResponse> {
  const providerOptions = providerOptionsForThinking(settings, thinkingControl);
  const systemPrompt = buildAIRecognitionSystemPrompt();
  const userPrompt = buildAIRecognitionUserPrompt({
    text: input.text,
    timezone,
    defaultCurrency,
    currentDate: todayDateOnly(timezone),
    imageCount: input.images.length,
    locale,
    configContext,
  });
  const capture: AIRecognitionCapture = {
    rawModelText: null,
    usage: null,
    finishReason: null,
    providerMetadata: null,
  };

  try {
    const generateForPrompt = async (nextUserPrompt: string) => await generateAIRecognitionObject({
      settings,
      input,
      systemPrompt,
      userPrompt: nextUserPrompt,
      providerOptions,
      maxOutputTokens,
      ...(abortSignal ? { abortSignal } : {}),
    });
    const initialGeneration = await generateForPrompt(userPrompt);
    return await finalizeAIRecognitionGeneration({
      settings,
      input,
      locale,
      configContext,
      thinkingControl,
      maxOutputTokens,
      systemPrompt,
      originalUserPrompt: userPrompt,
      initialGeneration,
      generateForPrompt,
    });
  } catch (error) {
    const cause = error instanceof AIRecognitionGenerationError ? error.causeError : error;
    const errorCapture = error instanceof AIRecognitionGenerationError ? error.capture : capture;
    const rawModelText = noObjectGeneratedText(cause) ?? errorCapture.rawModelText;
    const recoveredGeneration = recoverAIRecognitionGenerationFromRawText(rawModelText, {
      usage: noObjectGeneratedUsage(cause) ?? errorCapture.usage,
      finishReason: noObjectGeneratedFinishReason(cause) ?? errorCapture.finishReason,
      providerMetadata: errorCapture.providerMetadata,
    });
    if (recoveredGeneration) {
      const generateForPrompt = async (nextUserPrompt: string) => await generateAIRecognitionObject({
        settings,
        input,
        systemPrompt,
        userPrompt: nextUserPrompt,
        providerOptions,
        maxOutputTokens,
        ...(abortSignal ? { abortSignal } : {}),
      });
      try {
        return await finalizeAIRecognitionGeneration({
          settings,
          input,
          locale,
          configContext,
          thinkingControl,
          maxOutputTokens,
          systemPrompt,
          originalUserPrompt: userPrompt,
          initialGeneration: recoveredGeneration,
          generateForPrompt,
        });
      } catch {
        // raw text 恢复只把可解析 JSON 带回同一条最终校验链路；校验失败仍走原始模型错误诊断。
      }
    }
    const diagnostics = buildAIRecognitionDiagnostics({
      settings,
      input,
      thinkingControl,
      maxOutputTokens,
      systemPrompt,
      userPrompt,
      rawModelText,
      rawObject: null,
      usage: noObjectGeneratedUsage(cause) ?? errorCapture.usage,
      finishReason: noObjectGeneratedFinishReason(cause) ?? errorCapture.finishReason,
      providerMetadata: errorCapture.providerMetadata,
    });
    throw new AIRecognitionRunError(cause, diagnostics);
  }
}

/**
 * 执行流式 AI 识别。
 *
 * SSE 中的 progress/partial/text/reasoning 只服务前端进度面板，最终草稿仍只来自 recognition/final 的结构化对象。
 */
export async function runAIRecognitionStream({
  settings,
  input,
  locale,
  timezone,
  defaultCurrency,
  configContext,
  thinkingControl,
  maxOutputTokens,
  abortSignal,
  sink,
}: {
  settings: AiRecognitionSettings;
  input: AIRecognitionInput;
  locale: AppLocale;
  timezone: string;
  defaultCurrency: string;
  configContext: AIRecognitionPromptConfigContext;
  thinkingControl: AiThinkingControl | null;
  maxOutputTokens: number;
  abortSignal: AbortSignal;
  sink: AIRecognitionStreamSink;
}): Promise<AiRecognizeResponse> {
  const providerOptions = providerOptionsForThinking(settings, thinkingControl);
  const systemPrompt = buildAIRecognitionSystemPrompt();
  const userPrompt = buildAIRecognitionUserPrompt({
    text: input.text,
    timezone,
    defaultCurrency,
    currentDate: todayDateOnly(timezone),
    imageCount: input.images.length,
    locale,
    configContext,
  });
  const capture: AIRecognitionCapture = {
    rawModelText: null,
    usage: null,
    finishReason: null,
    providerMetadata: null,
  };

  try {
    sink.emit({ type: "recognition/progress", stage: "model-start" });
    const generateForPrompt = async (nextUserPrompt: string) => await generateAIRecognitionObjectStream({
      settings,
      input,
      systemPrompt,
      userPrompt: nextUserPrompt,
      providerOptions,
      maxOutputTokens,
      abortSignal,
      sink,
    });
    const initialGeneration = await generateForPrompt(userPrompt);
    return await finalizeAIRecognitionGeneration({
      settings,
      input,
      locale,
      configContext,
      thinkingControl,
      maxOutputTokens,
      systemPrompt,
      originalUserPrompt: userPrompt,
      initialGeneration,
      generateForPrompt,
      emitProgress: (stage) => sink.emit({ type: "recognition/progress", stage }),
    });
  } catch (error) {
    const cause = error instanceof AIRecognitionGenerationError ? error.causeError : error;
    const errorCapture = error instanceof AIRecognitionGenerationError ? error.capture : capture;
    const rawModelText = noObjectGeneratedText(cause) ?? errorCapture.rawModelText;
    const recoveredGeneration = recoverAIRecognitionGenerationFromRawText(rawModelText, {
      usage: noObjectGeneratedUsage(cause) ?? errorCapture.usage,
      finishReason: noObjectGeneratedFinishReason(cause) ?? errorCapture.finishReason,
      providerMetadata: errorCapture.providerMetadata,
    });
    if (recoveredGeneration) {
      const generateForPrompt = async (nextUserPrompt: string) => await generateAIRecognitionObjectStream({
        settings,
        input,
        systemPrompt,
        userPrompt: nextUserPrompt,
        providerOptions,
        maxOutputTokens,
        abortSignal,
        sink,
      });
      try {
        return await finalizeAIRecognitionGeneration({
          settings,
          input,
          locale,
          configContext,
          thinkingControl,
          maxOutputTokens,
          systemPrompt,
          originalUserPrompt: userPrompt,
          initialGeneration: recoveredGeneration,
          generateForPrompt,
          emitProgress: (stage) => sink.emit({ type: "recognition/progress", stage }),
        });
      } catch {
        // raw text 恢复只把可解析 JSON 带回同一条最终校验链路；校验失败仍走原始模型错误诊断。
      }
    }
    const diagnostics = buildAIRecognitionDiagnostics({
      settings,
      input,
      thinkingControl,
      maxOutputTokens,
      systemPrompt,
      userPrompt,
      rawModelText,
      rawObject: null,
      usage: noObjectGeneratedUsage(cause) ?? errorCapture.usage,
      finishReason: noObjectGeneratedFinishReason(cause) ?? errorCapture.finishReason,
      providerMetadata: errorCapture.providerMetadata,
    });
    throw new AIRecognitionRunError(cause, diagnostics);
  }
}

async function finalizeAIRecognitionGeneration({
  settings,
  input,
  locale,
  configContext,
  thinkingControl,
  maxOutputTokens,
  systemPrompt,
  originalUserPrompt,
  initialGeneration,
  generateForPrompt,
  emitProgress,
}: {
  settings: AiRecognitionSettings;
  input: AIRecognitionInput;
  locale: AppLocale;
  configContext: AIRecognitionPromptConfigContext;
  thinkingControl: AiThinkingControl | null;
  maxOutputTokens: number;
  systemPrompt: string;
  originalUserPrompt: string;
  initialGeneration: AIRecognitionGeneration;
  generateForPrompt: (userPrompt: string) => Promise<AIRecognitionGeneration>;
  emitProgress?: (stage: AiRecognitionStreamStage) => void;
}): Promise<AiRecognizeResponse> {
  let finalGeneration = initialGeneration;
  emitProgress?.("validating");
  let diagnostics = diagnosticsFromGeneration(settings, input, thinkingControl, maxOutputTokens, systemPrompt, originalUserPrompt, finalGeneration);
  let response = normalizeGeneratedAIRecognizeObject(finalGeneration.object, settings.providerType, settings.transportProtocol, settings.model, diagnostics, configContext);
  const missingNames = missingDescribableNoteNames(response.subscriptions);
  if (missingNames.length > 0) {
    emitProgress?.("repair-start");
    const repairPrompt = buildAIRecognitionRepairUserPrompt({
      originalUserPrompt,
      previousObject: finalGeneration.object,
      missingNoteNames: missingNames,
    });
    try {
      finalGeneration = await generateForPrompt(repairPrompt);
      diagnostics = diagnosticsFromGeneration(settings, input, thinkingControl, maxOutputTokens, systemPrompt, repairPrompt, finalGeneration);
      const repairedResponse = normalizeGeneratedAIRecognizeObject(finalGeneration.object, settings.providerType, settings.transportProtocol, settings.model, diagnostics, configContext);
      if (repairedResponse.subscriptions.length > 0) response = repairedResponse;
    } catch {
      diagnostics = diagnosticsFromGeneration(settings, input, thinkingControl, maxOutputTokens, systemPrompt, originalUserPrompt, initialGeneration);
      response = normalizeGeneratedAIRecognizeObject(initialGeneration.object, settings.providerType, settings.transportProtocol, settings.model, diagnostics, configContext);
    }
    response = fillMissingNotesWithDynamicFallback(response, locale, configContext);
  }
  emitProgress?.("finalizing");
  return response;
}

function recoverAIRecognitionGenerationFromRawText(
  rawModelText: string | null,
  capture: Pick<AIRecognitionCapture, "usage" | "finishReason" | "providerMetadata">,
): AIRecognitionGeneration | null {
  if (!rawModelText) return null;
  const jsonText = extractFirstAIRecognitionJSONObject(rawModelText);
  if (!jsonText) return null;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText) as unknown;
  } catch {
    return null;
  }
  const parsed = aiGeneratedRecognizeObjectSchema.safeParse(parsedJson);
  if (!parsed.success) return null;
  // AI SDK 结构化输出失败时仍可能带完整 JSON 文本；恢复后必须回到同一条最终 normalize/schema 链路，不能把 raw/partial 当草稿。
  return {
    object: parsed.data,
    rawModelText,
    usage: capture.usage,
    finishReason: capture.finishReason,
    providerMetadata: capture.providerMetadata,
  };
}

function extractFirstAIRecognitionJSONObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

async function generateAIRecognitionObject({
  settings,
  input,
  systemPrompt,
  userPrompt,
  providerOptions,
  maxOutputTokens,
  abortSignal,
}: {
  settings: AiRecognitionSettings;
  input: AIRecognitionInput;
  systemPrompt: string;
  userPrompt: string;
  providerOptions: Record<string, Record<string, JSONValue>> | undefined;
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
}): Promise<AIRecognitionGeneration> {
  const capture: AIRecognitionCapture = {
    rawModelText: null,
    usage: null,
    finishReason: null,
    providerMetadata: null,
  };
  try {
    const result = await generateObject({
      model: createAIRecognitionModel(settings, capture),
      system: systemPrompt,
      messages: buildAIRecognitionMessages(input, userPrompt),
      schema: aiGeneratedRecognizeObjectSchema,
      schemaName: AI_RECOGNITION_SCHEMA_NAME,
      maxOutputTokens,
      ...(providerOptions ? { providerOptions } : {}),
      maxRetries: 1,
      ...(abortSignal ? { abortSignal } : {}),
    });
    return {
      object: result.object,
      rawModelText: capture.rawModelText,
      usage: result.usage ?? capture.usage,
      finishReason: finishReasonText(result.finishReason) ?? capture.finishReason,
      providerMetadata: result.providerMetadata ?? capture.providerMetadata,
    };
  } catch (error) {
    throw new AIRecognitionGenerationError(error, capture);
  }
}

async function generateAIRecognitionObjectStream({
  settings,
  input,
  systemPrompt,
  userPrompt,
  providerOptions,
  maxOutputTokens,
  abortSignal,
  sink,
}: {
  settings: AiRecognitionSettings;
  input: AIRecognitionInput;
  systemPrompt: string;
  userPrompt: string;
  providerOptions: Record<string, Record<string, JSONValue>> | undefined;
  maxOutputTokens: number;
  abortSignal: AbortSignal;
  sink: AIRecognitionStreamSink;
}): Promise<AIRecognitionGeneration> {
  const capture: AIRecognitionCapture = {
    rawModelText: null,
    usage: null,
    finishReason: null,
    providerMetadata: null,
  };
  try {
    const result = streamText({
      model: createAIRecognitionLanguageModel(settings, resolveAIProviderEndpoint(settings).runtimeBaseUrl),
      system: systemPrompt,
      messages: buildAIRecognitionMessages(input, userPrompt),
      output: Output.object({
        schema: aiGeneratedRecognizeObjectSchema,
        name: AI_RECOGNITION_SCHEMA_NAME,
      }),
      maxOutputTokens,
      abortSignal,
      timeout: { totalMs: AI_RECOGNITION_PROVIDER_TIMEOUT_MS, chunkMs: 30_000 },
      ...(providerOptions ? { providerOptions } : {}),
      maxRetries: 1,
    });
    const outputPromise = Promise.resolve(result.output);
    const object = await settleAIRecognitionStreamTasks([
      outputPromise,
      consumeAIRecognitionFullStream(result.fullStream, sink, capture),
      consumeAIRecognitionPartialStream(result.partialOutputStream, sink),
    ]);
    return {
      object,
      rawModelText: capture.rawModelText,
      usage: await Promise.resolve(result.usage).catch(() => capture.usage),
      finishReason: finishReasonText(await Promise.resolve(result.finishReason).catch(() => capture.finishReason)) ?? capture.finishReason,
      providerMetadata: await Promise.resolve(result.providerMetadata).catch(() => capture.providerMetadata),
    };
  } catch (error) {
    throw new AIRecognitionGenerationError(error, capture);
  }
}

async function settleAIRecognitionStreamTasks(tasks: [
  Promise<AiGeneratedRecognizeObject>,
  Promise<void>,
  Promise<void>,
]): Promise<AiGeneratedRecognizeObject> {
  // AI SDK 会在 output/fullStream 不同通道抛错；等待全部 settle 后优先保留带 HTTP body 的 provider 错误。
  const results = await Promise.allSettled(tasks);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length > 0) throw selectAIRecognitionStreamError(errors);
  const output = results[0];
  if (output.status === "fulfilled") return output.value;
  throw new Error("AI recognition stream output missing");
}

function selectAIRecognitionStreamError(errors: unknown[]): unknown {
  let providerError: unknown | null = null;
  for (const error of errors) {
    const providerResponse = providerResponseFromError(error);
    if (!providerResponse) continue;
    if (providerResponse.body) return error;
    providerError ??= error;
  }
  return providerError ?? errors[0];
}

async function consumeAIRecognitionFullStream(
  fullStream: AsyncIterable<unknown>,
  sink: AIRecognitionStreamSink,
  capture: AIRecognitionCapture,
): Promise<void> {
  let rawModelText = "";
  for await (const part of fullStream) {
    if (!isRecord(part)) continue;
    switch (part["type"]) {
      case "text-delta": {
        const text = typeof part["delta"] === "string" ? part["delta"] : "";
        if (text) {
          rawModelText += text;
          capture.rawModelText = rawModelText;
          sink.emit({ type: "recognition/text-delta", delta: text });
          sink.emit({ type: "recognition/progress", stage: "model-stream" });
        }
        break;
      }
      case "reasoning-delta": {
        const text = typeof part["delta"] === "string" ? part["delta"] : "";
        if (text) {
          sink.emit({ type: "recognition/reasoning-delta", delta: text });
        }
        break;
      }
      case "finish-step":
      case "finish": {
        capture.usage = part["usage"] ?? capture.usage;
        capture.finishReason = finishReasonText(part["finishReason"]) ?? capture.finishReason;
        capture.providerMetadata = part["providerMetadata"] ?? capture.providerMetadata;
        break;
      }
      case "error":
        throw part["error"];
    }
  }
}

async function consumeAIRecognitionPartialStream(
  partialOutputStream: AsyncIterable<unknown>,
  sink: AIRecognitionStreamSink,
): Promise<void> {
  let lastSubscriptionsSeen = 0;
  let lastWarningsSeen = 0;
  for await (const partial of partialOutputStream) {
    const { subscriptionsSeen, warningsSeen } = partialAIRecognitionCounts(partial);
    if (subscriptionsSeen === 0 && warningsSeen === 0) continue;
    if (subscriptionsSeen === lastSubscriptionsSeen && warningsSeen === lastWarningsSeen) continue;
    // partialOutputStream 会重复吐半成品对象；这里去噪只影响进度 UI，最终草稿仍只能来自 recognition/final。
    lastSubscriptionsSeen = subscriptionsSeen;
    lastWarningsSeen = warningsSeen;
    sink.emit({ type: "recognition/partial", subscriptionsSeen, warningsSeen });
  }
}

function partialAIRecognitionCounts(value: unknown): { subscriptionsSeen: number; warningsSeen: number } {
  if (!isRecord(value)) return { subscriptionsSeen: 0, warningsSeen: 0 };
  const subscriptions = value["subscriptions"];
  const warnings = value["warnings"];
  return {
    subscriptionsSeen: Array.isArray(subscriptions) ? subscriptions.length : 0,
    warningsSeen: Array.isArray(warnings) ? warnings.length : 0,
  };
}

function diagnosticsFromGeneration(
  settings: AiRecognitionSettings,
  input: AIRecognitionInput,
  thinkingControl: AiThinkingControl | null,
  maxOutputTokens: number,
  systemPrompt: string,
  userPrompt: string,
  generation: AIRecognitionGeneration,
): AiRecognitionDiagnostics {
  return buildAIRecognitionDiagnostics({
    settings,
    input,
    thinkingControl,
    maxOutputTokens,
    systemPrompt,
    userPrompt,
    rawModelText: generation.rawModelText,
    rawObject: generation.object,
    usage: generation.usage,
    finishReason: generation.finishReason,
    providerMetadata: generation.providerMetadata,
  });
}

/** 校验用户设置中的模型、base URL 和 API key；真正的 provider 请求只在通过后才会发出。 */
export function assertAIRecognitionSettings(settings: AiRecognitionSettings, locale: AppLocale): void {
  if (!settings.model.trim()) {
    throw new HttpError(400, serverText(locale, "aiRecognition.modelRequired"), "AI_MODEL_REQUIRED");
  }
  const endpoint = resolveAIProviderEndpoint(settings);
  if (endpoint.baseUrlRequired && !settings.baseUrl.trim()) {
    throw new HttpError(400, serverText(locale, "aiRecognition.baseUrlRequired"), "AI_BASE_URL_REQUIRED");
  }
  if (endpoint.apiKeyRequired && !settings.apiKey.trim()) {
    throw new HttpError(400, serverText(locale, "aiRecognition.apiKeyRequired"), "AI_API_KEY_REQUIRED");
  }
}

/** 把模型/校验异常收敛成 shared SSE error event，避免向前端透传 AI SDK 原始错误对象。 */
export function aiRecognitionStreamErrorEvent(locale: AppLocale, error: unknown): AiRecognitionStreamEvent {
  if (error instanceof HttpError) {
    const parsedDetails = aiRecognitionErrorDetailsSchema.safeParse(error.details);
    return aiRecognitionStreamEventSchema.parse({
      type: "recognition/error",
      message: error.message,
      code: error.code ?? "AI_RECOGNITION_FAILED",
      ...(parsedDetails.success ? { details: parsedDetails.data } : {}),
    });
  }
  const diagnostics = aiRecognitionDiagnosticsFromError(error);
  const cause = aiRecognitionCauseFromError(error);
  if (diagnostics && isAIRecognitionSchemaMismatch(error)) {
    return aiRecognitionStreamEventSchema.parse({
      type: "recognition/error",
      message: serverText(locale, "aiRecognition.schemaMismatch"),
      code: "AI_RECOGNITION_SCHEMA_MISMATCH",
      details: aiRecognitionErrorDetails("schema_mismatch", cause, diagnostics),
    });
  }
  return aiRecognitionStreamEventSchema.parse({
    type: "recognition/error",
    message: serverText(locale, "aiRecognition.failed"),
    code: "AI_RECOGNITION_FAILED",
    ...(diagnostics ? { details: aiRecognitionErrorDetails("provider_failed", cause, diagnostics) } : {}),
  });
}

/** 超时事件保留 diagnostics 时仍走同一脱敏结构，前端只通过 code 区分可提示文案。 */
export function aiRecognitionStreamTimeoutErrorEvent(locale: AppLocale, error: unknown): AiRecognitionStreamEvent {
  const diagnostics = aiRecognitionDiagnosticsFromError(error);
  const cause = aiRecognitionCauseFromError(error);
  return aiRecognitionStreamEventSchema.parse({
    type: "recognition/error",
    message: serverText(locale, "aiRecognition.failed"),
    code: "AI_RECOGNITION_TIMEOUT",
    ...(diagnostics ? { details: aiRecognitionErrorDetails("provider_failed", cause, diagnostics) } : {}),
  });
}

/** schema mismatch 是“模型没有产出可用对象”的用户可诊断失败，不等同于 Worker 内部错误。 */
export function isAIRecognitionSchemaMismatch(error: unknown): boolean {
  const cause = aiRecognitionCauseFromError(error);
  const message = (cause instanceof Error ? cause.message : String(cause)).toLowerCase();
  return message.includes("no object generated")
    || message.includes("did not match schema")
    || message.includes("schema validation")
    || message.includes("invalid object");
}

/** 只从内部 run error 取 diagnostics，避免任意外部异常伪造调试信息进入响应。 */
export function aiRecognitionDiagnosticsFromError(error: unknown): AiRecognitionDiagnostics | null {
  return error instanceof AIRecognitionRunError ? error.diagnostics : null;
}

/** 解除内部错误包装，供脱敏层读取真实 provider/schema 失败原因。 */
export function aiRecognitionCauseFromError(error: unknown): unknown {
  return error instanceof AIRecognitionRunError ? error.causeError : error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
