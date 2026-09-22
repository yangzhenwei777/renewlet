/**
 * Worker AI SDK runtime adapter。
 *
 * 这里把 shared provider endpoint 转成 AI SDK language model，并通过 middleware 捕获 raw text/usage，供 diagnostics 脱敏后返回。
 */
import { generateText, wrapLanguageModel, type JSONValue, type ModelMessage, type UserContent } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  aiRecognitionSettingsSchema,
  type AiRecognitionSettings,
  type AiThinkingControl,
} from "@renewlet/shared/schemas/ai-recognition";
import { resolveAIProviderEndpoint } from "@renewlet/shared/ai-provider-endpoints";
import { extractAIModelText, finishReasonText } from "./ai-recognition-diagnostics";
import { sendUpstreamRequest } from "./upstream-http";

const AI_RECOGNITION_TEST_TEXT = "Reply with OK.";
export const AI_RECOGNITION_PROVIDER_TIMEOUT_MS = 90_000;

export type AIRecognitionRuntimeInput = {
  text: string;
  images: Array<{ data: Uint8Array; mediaType: string }>;
};

/** 捕获 provider 响应事实供 diagnostics 使用；这里不保存 API key、请求头或图片原文。 */
export type AIRecognitionCapture = {
  rawModelText: string | null;
  usage: unknown | null;
  finishReason: string | null;
  providerMetadata: unknown | null;
};

/** 创建带 capture middleware 的模型实例；调用方负责在响应前统一脱敏 capture 内容。 */
export function createAIRecognitionModel(settings: AiRecognitionSettings, capture: AIRecognitionCapture) {
  const canonicalSettings = aiRecognitionSettingsSchema.parse(settings);
  const endpoint = resolveAIProviderEndpoint(canonicalSettings);
  const model = createAIRecognitionLanguageModel(canonicalSettings, endpoint.runtimeBaseUrl);

  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      async wrapGenerate({ doGenerate }) {
        const result = await doGenerate();
        // capture 只记录 provider 事实，真正返回前仍会经过 diagnostics 脱敏；不要在这里拼用户可见错误。
        capture.rawModelText = extractAIModelText(result.content) ?? capture.rawModelText;
        capture.usage = result.usage ?? capture.usage;
        capture.finishReason = finishReasonText(result.finishReason) ?? capture.finishReason;
        capture.providerMetadata = result.providerMetadata ?? capture.providerMetadata;
        return result;
      },
    },
  });
}

/** 按 canonical transport 选择 AI SDK provider，避免 providerType 与 transportProtocol 历史错配。 */
export function createAIRecognitionLanguageModel(settings: AiRecognitionSettings, runtimeBaseUrl: string) {
  const upstreamFetch = createAIRecognitionUpstreamFetch(settings);
  if (settings.transportProtocol === "anthropic-messages") {
    return createAnthropic({
      apiKey: settings.apiKey,
      baseURL: runtimeBaseUrl,
      fetch: upstreamFetch,
    })(settings.model);
  }
  if (settings.transportProtocol === "gemini-generate-content") {
    return createGoogleGenerativeAI({
      apiKey: settings.apiKey,
      baseURL: runtimeBaseUrl,
      fetch: upstreamFetch,
    })(settings.model);
  }
  if (settings.providerType === "openai") {
    return createOpenAI({ apiKey: settings.apiKey, baseURL: runtimeBaseUrl, fetch: upstreamFetch }).chat(settings.model);
  }
  return createOpenAICompatible({
    name: settings.providerType,
    baseURL: runtimeBaseUrl,
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
    supportsStructuredOutputs: true,
    fetch: upstreamFetch,
  })(settings.model);
}

/** connection test 只验证最小文本生成能力，不触发订阅 schema、图片输入或 repair 链路。 */
export async function runAIRecognitionConnectionTest(settings: AiRecognitionSettings, abortSignal?: AbortSignal): Promise<void> {
  const canonicalSettings = aiRecognitionSettingsSchema.parse(settings);
  // 连接测试刻意绕开 schema/repair/thinking/retry，只验证当前协议能完成最小文本生成。
  await generateText({
    model: createAIRecognitionLanguageModel(canonicalSettings, resolveAIProviderEndpoint(canonicalSettings).runtimeBaseUrl),
    prompt: AI_RECOGNITION_TEST_TEXT,
    maxOutputTokens: 16,
    maxRetries: 0,
    ...(abortSignal ? { abortSignal } : {}),
    timeout: { totalMs: AI_RECOGNITION_PROVIDER_TIMEOUT_MS },
  });
}

function createAIRecognitionUpstreamFetch(settings: AiRecognitionSettings): typeof fetch {
  const secrets = settings.apiKey ? [settings.apiKey] : [];
  const provider = aiRecognitionProviderLabel(settings);
  // AI SDK 7 的 generateObject 不再接收 timeout；provider 网络总时限统一落在 custom fetch，避免非流式识别无界等待。
  return async (input, init) => await sendUpstreamRequest(input, init ?? {}, {
    provider,
    secrets,
    timeoutMs: AI_RECOGNITION_PROVIDER_TIMEOUT_MS,
  });
}

function aiRecognitionProviderLabel(settings: AiRecognitionSettings): string {
  if (settings.transportProtocol === "anthropic-messages") return "Anthropic";
  if (settings.transportProtocol === "gemini-generate-content") return "Gemini";
  if (settings.providerType === "openai") return "OpenAI";
  return `${settings.providerType} AI`;
}

/** 判断 thinking control 是否属于当前 provider；错配值只能丢弃，不能跨 provider 复用。 */
export function thinkingControlMatchesSettings(settings: AiRecognitionSettings, control: AiThinkingControl): boolean {
  if (settings.transportProtocol === "openai-chat") return settings.providerType === "openai" && control.provider === "openai";
  if (settings.transportProtocol === "anthropic-messages") return settings.providerType === "anthropic" && control.provider === "anthropic";
  return settings.providerType === "gemini" && control.provider === "gemini";
}

export function providerOptionsForThinking(settings: AiRecognitionSettings, control: AiThinkingControl | null): Record<string, Record<string, JSONValue>> | undefined {
  // thinking options 是 provider 私有协议；不匹配当前设置时直接丢弃，避免 AI SDK 把无效参数发给第三方。
  if (!control) return undefined;
  if (control.provider === "openai") {
    if (settings.providerType !== "openai" || settings.transportProtocol !== "openai-chat") return undefined;
    return { openai: { reasoningEffort: control.effort } };
  }
  if (control.provider === "gemini") {
    if (settings.providerType !== "gemini" || settings.transportProtocol !== "gemini-generate-content") return undefined;
    if (control.mode === "off") return { google: { thinkingConfig: { thinkingBudget: 0 } } };
    if (control.mode === "dynamic") return { google: { thinkingConfig: { thinkingBudget: -1 } } };
    if (control.mode === "budget") return { google: { thinkingConfig: { thinkingBudget: control.budget } } };
    return { google: { thinkingConfig: { thinkingLevel: control.level } } };
  }
  if (settings.providerType !== "anthropic" || settings.transportProtocol !== "anthropic-messages") return undefined;
  if (control.mode === "effort") {
    return { anthropic: { effort: control.effort } };
  }
  return { anthropic: { thinking: { type: "enabled", budgetTokens: control.budgetTokens } } };
}

/** 将文本和图片组合成 AI SDK message；图片二进制只在本次请求中进入第三方 provider，不进入 diagnostics。 */
export function buildAIRecognitionMessages(input: AIRecognitionRuntimeInput, userPrompt: string): ModelMessage[] {
  const content: UserContent = [
    { type: "text", text: userPrompt },
    ...input.images.map((image) => ({ type: "image" as const, image: image.data, mediaType: image.mediaType })),
  ];
  return [{ role: "user", content }];
}

/** 识别提示词使用用户时区中的 date-only today，避免 UTC 日期让续费日推断偏一天。 */
export function todayDateOnly(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}
