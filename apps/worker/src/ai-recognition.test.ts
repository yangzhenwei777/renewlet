import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { readSuccessData } from "./api-test-helpers";
import { recognizeSubscriptions, testAIRecognitionConnection } from "./ai-recognition";
import { generatedDraft } from "./ai-recognition.test-utils";
import type { Env } from "./types";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getCustomConfig: vi.fn(),
  listSubscriptionTags: vi.fn(),
}));

const aiMocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
  streamText: vi.fn(),
  outputObject: vi.fn((options: unknown) => options),
  wrapLanguageModel: vi.fn(({ model }: { model: unknown }) => model),
  isNoObjectGeneratedError: vi.fn((error: unknown) => Boolean(error && typeof error === "object" && "__noObjectGenerated" in error)),
  isAPICallError: vi.fn((error: unknown) => Boolean(error && typeof error === "object" && "__apiCallError" in error)),
}));

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

vi.mock("./db", () => ({
  getSettings: dbMocks.getSettings,
  getCustomConfig: dbMocks.getCustomConfig,
  listSubscriptionTags: dbMocks.listSubscriptionTags,
}));

vi.mock("ai", () => ({
  generateObject: aiMocks.generateObject,
  generateText: aiMocks.generateText,
  streamText: aiMocks.streamText,
  Output: {
    object: aiMocks.outputObject,
  },
  wrapLanguageModel: aiMocks.wrapLanguageModel,
  NoObjectGeneratedError: {
    isInstance: aiMocks.isNoObjectGeneratedError,
  },
  APICallError: {
    isInstance: aiMocks.isAPICallError,
  },
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => Object.assign(
    vi.fn(() => ({ provider: "openai.responses" })),
    { chat: vi.fn(() => ({ provider: "openai.chat" })) },
  )),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn(() => ({ provider: "gemini" }))),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({ provider: "anthropic" }))),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => vi.fn(() => ({ provider: "openai-compatible" }))),
}));

const authUser = {
  id: "usr_ai",
  email: "ai@example.com",
  name: "AI User",
  role: "admin" as const,
  banned: 0,
  ban_reason: "",
  password_hash: "hash",
  reset_token_hash: null,
  reset_token_expires_at: null,
  created_at: "2026-06-05T00:00:00.000Z",
  updated_at: "2026-06-05T00:00:00.000Z",
};

function envFixture(): Env {
  return { DB: {} as D1Database, ASSETS: {} as Fetcher, ASSETS_BUCKET: {} as R2Bucket };
}

function requestForText(text: string, locale = "zh-CN"): Request {
  const form = new FormData();
  form.set("text", text);
  return new Request("https://renewlet.test/api/app/ai/subscriptions/recognize", {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      "x-renewlet-locale": locale,
      "x-client-time-zone": "Asia/Shanghai",
    },
    body: form,
  });
}

function requestForTextWithThinking(text: string, thinkingControl: string): Request {
  const form = new FormData();
  form.set("text", text);
  form.set("thinkingControl", thinkingControl);
  return new Request("https://renewlet.test/api/app/ai/subscriptions/recognize", {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      "x-renewlet-locale": "zh-CN",
      "x-client-time-zone": "Asia/Shanghai",
    },
    body: form,
  });
}

function testConnectionRequestFor(
  settings: Record<string, unknown>,
  apiKeyMutation?: { action: "keep" | "clear" } | { action: "set"; value: string },
): Request {
  const { apiKey, ...publicSettings } = settings;
  const mutation = apiKeyMutation ?? (
    typeof apiKey === "string" && apiKey.length > 0
      ? { action: "set" as const, value: apiKey }
      : { action: "clear" as const }
  );
  return new Request("https://renewlet.test/api/app/ai/subscriptions/test", {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      "content-type": "application/json",
      "x-renewlet-locale": "zh-CN",
    },
    body: JSON.stringify({ settings: publicSettings, apiKey: mutation }),
  });
}


function noObjectGeneratedErrorWithText(text: string): Error {
  return Object.assign(new Error("No object generated: response did not match schema."), {
    __noObjectGenerated: true,
    text,
    usage: { inputTokens: 10, outputTokens: 20 },
    finishReason: "stop",
  });
}

describe("Cloudflare AI recognition", () => {
  beforeEach(() => {
    authMocks.requireAuth.mockReset();
    dbMocks.getSettings.mockReset();
    dbMocks.listSubscriptionTags.mockReset();
    aiMocks.generateObject.mockReset();
    aiMocks.generateText.mockReset();
    aiMocks.streamText.mockReset();
    aiMocks.outputObject.mockClear();
    aiMocks.wrapLanguageModel.mockClear();
    aiMocks.isNoObjectGeneratedError.mockClear();
    aiMocks.isAPICallError.mockClear();
    vi.mocked(createOpenAI).mockClear();
    vi.mocked(createGoogleGenerativeAI).mockClear();
    vi.mocked(createAnthropic).mockClear();
    vi.mocked(createOpenAICompatible).mockClear();
    authMocks.requireAuth.mockResolvedValue({ user: authUser, session: { id: "ses" } });
    dbMocks.getSettings.mockResolvedValue({
      aiRecognition: {
        providerType: "openai",
        transportProtocol: "openai-chat",
        model: "gpt-5.1",
        modelInputMode: "select",
        baseUrl: "",
        apiKey: "sk-test",
        defaultThinkingControl: null,
      },
      timezone: "Asia/Shanghai",
      defaultCurrency: "CNY",
    });
    dbMocks.getCustomConfig.mockResolvedValue({
      categories: [{
        id: "cat_hosting",
        value: "hosting_domains",
        labels: { "zh-CN": "域名与托管", "en-US": "Domains & Hosting" },
      }],
      statuses: [],
      paymentMethods: [{
        id: "pay_crypto",
        value: "crypto",
        labels: { "zh-CN": "加密货币", "en-US": "Crypto" },
      }],
      currencies: [],
    });
    dbMocks.listSubscriptionTags.mockResolvedValue(["VPS", "云服务器"]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes complete AI SDK objects into strict API drafts", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "dmit",
          price: "15元",
          currency: "元",
          billingCycle: "1个月",
          category: "域名与托管",
          paymentMethod: "Crypto",
          website: { value: "https://www.dmit.io/", source: "suggested" },
          notes: { value: "DMIT 是提供 VPS、云服务器和网络线路服务的主机商。", source: "suggested" },
          tags: ["云服务", "云服务", "VPS"],
        })],
        warnings: [],
      },
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      finishReason: "stop",
      providerMetadata: { openai: { responseId: "resp_test" } },
    });

    const response = await recognizeSubscriptions(requestForText("dmit 15元 1个月"), envFixture());
    const body = await readSuccessData<{
      providerType: string;
      transportProtocol: string;
      model: string;
      subscriptions: Array<{
        name: string;
        price: number;
        currency: string;
        billingCycle: string;
        category: string;
        paymentMethod: string;
        website: { value: string; source: string } | null;
        notes: { value: string; source: string } | null;
        tags: string[];
        warnings: string[];
      }>;
      diagnostics: {
        schemaName: string;
        prompt: { system: { value: string }; user: { value: string } };
        output: { rawObjectJson: { value: string } | null; rawModelText: { value: string } | null };
        request: { providerType: string; transportProtocol: string; model: string; textCharCount: number; images: Array<{ mediaType: string; sizeBytes: number }> };
        response: { usage: unknown; finishReason: string | null; providerMetadata: unknown };
      };
    }>(response);

    expect(response.status).toBe(200);
    expect(body.providerType).toBe("openai");
    expect(body.transportProtocol).toBe("openai-chat");
    expect(body.model).toBe("gpt-5.1");
    expect(body.subscriptions[0]).toMatchObject({
      name: "dmit",
      price: "15",
      currency: "CNY",
      billingCycle: "monthly",
      category: "hosting_domains",
      paymentMethod: "crypto",
      website: { value: "https://www.dmit.io/", source: "suggested" },
      notes: { value: "DMIT 是提供 VPS、云服务器和网络线路服务的主机商。", source: "suggested" },
      tags: ["云服务", "VPS"],
      warnings: [],
    });
    expect(body.diagnostics.schemaName).toBe("renewlet_ai_subscription_recognition");
    expect(body.diagnostics.prompt.system.value).toContain("Return exactly one valid JSON object parseable by JSON.parse");
    expect(body.diagnostics.prompt.system.value).toContain("Do generate useful service and website metadata");
    expect(body.diagnostics.prompt.system.value).toContain("Examples show output shape and decision patterns only");
    expect(body.diagnostics.prompt.user.value).toContain("dmit 15元 1个月");
    expect(body.diagnostics.prompt.user.value).toContain("Runtime context:");
    expect(body.diagnostics.prompt.user.value).toContain("- User locale: zh-CN");
    expect(body.diagnostics.prompt.user.value).toContain("User context:");
    expect(body.diagnostics.prompt.user.value).toContain("Task:");
    expect(body.diagnostics.prompt.user.value).toContain("Examples:");
    expect(aiMocks.generateObject).toHaveBeenCalledWith(expect.objectContaining({
      abortSignal: expect.any(AbortSignal),
    }));
    expect(vi.mocked(createOpenAI).mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      apiKey: "sk-test",
      fetch: expect.any(Function),
    }));
    expect(body.diagnostics.prompt.user.value).toContain("<<<renewlet-user-input");
    expect(body.diagnostics.prompt.user.value).toContain("value=hosting_domains");
    expect(body.diagnostics.prompt.user.value).toContain("value=crypto");
    expect(body.diagnostics.prompt.user.value).toContain("Existing user tags:");
    expect(body.diagnostics.prompt.user.value).toContain("- VPS");
    expect(body.diagnostics.prompt.user.value).not.toContain("https://www.apple.com/");
    expect(body.diagnostics.prompt.user.value).not.toContain("YouTube 是 Google 旗下的视频分享和流媒体平台。");
    expect(body.diagnostics.prompt.user.value).not.toContain("LOCVPS 是面向 VPS、云服务器和服务器托管的主机服务商。");
    expect(body.diagnostics.prompt.user.value).not.toContain("DMIT 是提供 VPS、云服务器和网络线路服务的主机商。");
    expect(body.diagnostics.output.rawObjectJson?.value).toContain("\"name\": \"dmit\"");
    expect(body.diagnostics.request).toMatchObject({ providerType: "openai", transportProtocol: "openai-chat", model: "gpt-5.1", textCharCount: 12, images: [] });
    expect(body.diagnostics.response.finishReason).toBe("stop");
  });

  it("includes locale-first language rules in English recognition diagnostics", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          currency: "USD",
          notes: { value: "DMIT is a hosting provider for VPS and cloud server services.", source: "suggested" },
          tags: ["VPS", "Cloud hosting"],
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("dmit 2 months 15dollar", "en-US"), envFixture());
    const body = await readSuccessData<{
      diagnostics: { prompt: { user: { value: string } } };
    }>(response);

    expect(response.status).toBe(200);
    expect(body.diagnostics.prompt.user.value).toContain("- User locale: en-US");
    expect(body.diagnostics.prompt.user.value).toContain("Generated user-facing metadata must follow User locale");
    expect(body.diagnostics.prompt.user.value).toContain("use English for en-US and Simplified Chinese for zh-CN");
    expect(body.diagnostics.prompt.user.value).toContain("Do not translate source=input text, Existing user tags");
  });

  it("does not apply saved default thinking when the multipart field is absent", async () => {
    dbMocks.getSettings.mockResolvedValue({
      aiRecognition: {
        providerType: "openai",
        transportProtocol: "openai-chat",
        model: "gpt-5.1",
        modelInputMode: "select",
        baseUrl: "",
        apiKey: "sk-test",
        defaultThinkingControl: { provider: "openai", effort: "high" },
      },
      timezone: "Asia/Shanghai",
      defaultCurrency: "CNY",
    });
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft()],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("dmit 15元 1个月"), envFixture());
    const body = await readSuccessData<{ diagnostics: { request: { thinkingControl: unknown } } }>(response);
    const call = aiMocks.generateObject.mock.calls[0]?.[0] as { providerOptions?: unknown };

    expect(call.providerOptions).toBeUndefined();
    expect(body.diagnostics.request.thinkingControl).toBeNull();
  });

  it("passes explicit thinking controls to provider options and diagnostics", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft()],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(
      requestForTextWithThinking("dmit 15元 1个月", JSON.stringify({ provider: "openai", effort: "high" })),
      envFixture(),
    );
    const body = await readSuccessData<{ diagnostics: { request: { thinkingControl: unknown } } }>(response);
    const call = aiMocks.generateObject.mock.calls[0]?.[0] as { providerOptions?: unknown };

    expect(call.providerOptions).toEqual({ openai: { reasoningEffort: "high" } });
    expect(body.diagnostics.request.thinkingControl).toEqual({ provider: "openai", effort: "high" });
  });

  it("tests provider connection with a minimal text request and no recognition chain", async () => {
    aiMocks.generateText.mockResolvedValue({ text: "OK" });

    const response = await testAIRecognitionConnection(testConnectionRequestFor({
      providerType: "openai",
      transportProtocol: "openai-chat",
      model: "gpt-5.1",
      modelInputMode: "select",
      baseUrl: "",
      apiKey: "sk-test",
      defaultThinkingControl: { provider: "openai", effort: "high" },
    }, { action: "keep" }), envFixture());
    const body = await readSuccessData<{ providerType: string; transportProtocol: string; model: string }>(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({ providerType: "openai", transportProtocol: "openai-chat", model: "gpt-5.1" });
    expect(aiMocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "openai.chat" },
      prompt: "Reply with OK.",
      maxOutputTokens: 16,
      maxRetries: 0,
      abortSignal: expect.any(AbortSignal),
      timeout: { totalMs: 90_000 },
    }));
    expect(vi.mocked(createOpenAI).mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      apiKey: "sk-test",
      fetch: expect.any(Function),
    }));
    expect(aiMocks.generateObject).not.toHaveBeenCalled();
    expect(aiMocks.wrapLanguageModel).not.toHaveBeenCalled();
  });

  it("returns raw provider response details when connection test fails", async () => {
    aiMocks.generateText.mockRejectedValue(Object.assign(new Error("invalid key sk-test-secret"), {
      __apiCallError: true,
      statusCode: 401,
      responseHeaders: { "content-type": "application/json" },
      responseBody: "{\"code\":\"INVALID_API_KEY\",\"message\":\"bad sk-test-secret\"}",
    }));

    await expect(testAIRecognitionConnection(testConnectionRequestFor({
      providerType: "openai",
      transportProtocol: "openai-chat",
      model: "gpt-5.1",
      modelInputMode: "select",
      baseUrl: "",
      apiKey: "sk-test",
      defaultThinkingControl: null,
    }), envFixture())).rejects.toMatchObject({
      status: 400,
      code: "AI_RECOGNITION_TEST_FAILED",
      details: {
        rawResponseText: "{\"code\":\"INVALID_API_KEY\",\"message\":\"bad [redacted]\"}",
      },
    });
  });

  it("canonicalizes mismatched compatible protocol to OpenAI chat runtime", async () => {
    aiMocks.generateText.mockResolvedValue({ text: "OK" });

    const response = await testAIRecognitionConnection(testConnectionRequestFor({
      providerType: "openai-compatible",
      transportProtocol: "anthropic-messages",
      model: "claude-compatible",
      modelInputMode: "manual",
      baseUrl: "https://gateway.example.com/anthropic/v1",
      apiKey: "",
      defaultThinkingControl: null,
    }), envFixture());
    const body = await readSuccessData<{ providerType: string; transportProtocol: string }>(response);

    expect(body).toMatchObject({ providerType: "openai-compatible", transportProtocol: "openai-chat" });
    expect(aiMocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "openai-compatible" },
    }));
  });

  it("rejects invalid thinking control fields", async () => {
    await expect(
      recognizeSubscriptions(requestForTextWithThinking("dmit 15元 1个月", "{bad json"), envFixture()),
    ).rejects.toMatchObject({
      status: 400,
      code: "AI_THINKING_CONTROL_INVALID",
    });
  });

  it("drops recognition process notes from provider output", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "unknown app",
          price: 12,
          currency: "CNY",
          billingCycle: "monthly",
          website: null,
          notes: { value: "输入没有提供官网或更多上下文，AI 未能高置信识别该服务。", source: "suggested" },
          confidence: "low",
          warnings: ["AI_WARNING_WEBSITE_UNCERTAIN"],
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("unknown app 12 1个月"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ notes: unknown; warnings: string[] }> }>(response);

    expect(body.subscriptions[0]?.notes).toBeNull();
    expect(body.subscriptions[0]?.warnings).toContain("AI_WARNING_WEBSITE_UNCERTAIN");
  });

  it("removes Renewlet-facing advice from service notes", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "locvps",
          price: 15,
          currency: "CNY",
          billingCycle: "monthly",
          notes: { value: "LOCVPS 提供 VPS、云服务器和服务器托管相关服务，适合记录主机或服务器套餐订阅。", source: "suggested" },
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("locvps 15元 1个月"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ notes: { value: string; source: string } | null }> }>(response);

    expect(body.subscriptions[0]?.notes).toEqual({
      value: "LOCVPS 提供 VPS、云服务器和服务器托管服务",
      source: "suggested",
    });
  });

  it("keeps high-confidence public service descriptions from the provider", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "youtube",
          price: "15刀",
          currency: "USD",
          billingCycle: "1年",
          website: { value: "https://www.youtube.com/", source: "suggested" },
          notes: { value: "YouTube 是 Google 旗下的视频分享和流媒体平台。", source: "suggested" },
          tags: ["视频", "流媒体", "Google"],
          confidence: "high",
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("youtube 15刀 1年"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ notes: { value: string; source: string } | null; warnings: string[] }> }>(response);

    expect(body.subscriptions[0]?.notes).toEqual({
      value: "YouTube 是 Google 旗下的视频分享和流媒体平台。",
      source: "suggested",
    });
    expect(body.subscriptions[0]?.warnings).not.toContain("AI_WARNING_NOTES_MISSING");
  });

  it("reuses existing tags and filters one-off generated attributes", async () => {
    dbMocks.listSubscriptionTags.mockResolvedValue(["VPS", "云服务器"]);
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "HostDZire IN CloudVPS #5 (FAT32 Special)",
          tags: ["vps", "孟买", "Debian 12"],
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("HostDZire IN CloudVPS #5 FAT32 Special Debian 12 Mumbai"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ tags: string[] }> }>(response);

    expect(body.subscriptions[0]?.tags).toEqual(["VPS"]);
  });

  it("drops one-off generated attributes when they are not existing tags", async () => {
    dbMocks.listSubscriptionTags.mockResolvedValue([]);
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "HostDZire IN CloudVPS #5 (FAT32 Special)",
          tags: ["孟买", "Debian 12", "FAT32 Special"],
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("HostDZire IN CloudVPS #5 FAT32 Special Debian 12 Mumbai"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ tags: string[] }> }>(response);

    expect(body.subscriptions[0]?.tags).toEqual([]);
  });

  it("keeps stable generated tags when no existing tags fit", async () => {
    dbMocks.listSubscriptionTags.mockResolvedValue([]);
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "dmit",
          tags: ["VPS", "云服务器", "Debian 12"],
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("dmit 15元 1个月"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ tags: string[] }> }>(response);

    expect(body.subscriptions[0]?.tags).toEqual(["VPS", "云服务器"]);
  });

  it("repairs missing notes for describable services with the same model", async () => {
    aiMocks.generateObject.mockResolvedValueOnce({
      object: {
        subscriptions: [generatedDraft({
          name: "HostDZire CloudVPS",
          website: { value: "https://hostdzire.com/", source: "suggested" },
          notes: { value: null, source: "none" },
          tags: ["VPS", "云主机"],
          confidence: "high",
        })],
        warnings: [],
      },
      finishReason: "stop",
    }).mockResolvedValueOnce({
      object: {
        subscriptions: [generatedDraft({
          name: "HostDZire CloudVPS",
          website: { value: "https://hostdzire.com/", source: "suggested" },
          notes: { value: "HostDZire CloudVPS 是提供 VPS 和云主机相关产品或服务的订阅服务。", source: "suggested" },
          tags: ["VPS", "云主机"],
          confidence: "high",
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("HostDZire CloudVPS 15元 1个月"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ notes: unknown; warnings: string[] }> }>(response);

    expect(aiMocks.generateObject).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(aiMocks.generateObject.mock.calls[1]?.[0])).toContain("Repair task:");
    expect(body.subscriptions[0]?.notes).toEqual({
      value: "HostDZire CloudVPS 是提供 VPS 和云主机相关产品或服务的订阅服务。",
      source: "suggested",
    });
    expect(body.subscriptions[0]?.warnings).not.toContain("AI_WARNING_NOTES_MISSING");
  });

  it("uses dynamic fallback notes when repair still omits a describable service description", async () => {
    const missingNotesDraft = generatedDraft({
      name: "HostDZire CloudVPS",
      website: { value: "https://hostdzire.com/", source: "suggested" },
      notes: { value: null, source: "none" },
      tags: ["VPS", "云主机"],
      confidence: "high",
    });
    aiMocks.generateObject.mockResolvedValueOnce({
      object: {
        subscriptions: [missingNotesDraft],
        warnings: [],
      },
      finishReason: "stop",
    }).mockResolvedValueOnce({
      object: {
        subscriptions: [missingNotesDraft],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("HostDZire CloudVPS 15元 1个月"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ notes: unknown; warnings: string[] }> }>(response);

    expect(aiMocks.generateObject).toHaveBeenCalledTimes(2);
    expect(body.subscriptions[0]?.notes).toEqual({
      value: "HostDZire CloudVPS 是提供 VPS、云主机相关产品或服务的订阅服务。",
      source: "suggested",
    });
    expect(body.subscriptions[0]?.warnings).not.toContain("AI_WARNING_NOTES_MISSING");
  });

  it("keeps unknown low-confidence services without notes", async () => {
    aiMocks.generateObject.mockResolvedValue({
      object: {
        subscriptions: [generatedDraft({
          name: "unknown app",
          website: null,
          notes: { value: null, source: "none" },
          tags: [],
          confidence: "low",
          warnings: ["AI_WARNING_WEBSITE_UNCERTAIN", "AI_WARNING_LOW_CONFIDENCE"],
        })],
        warnings: [],
      },
      finishReason: "stop",
    });

    const response = await recognizeSubscriptions(requestForText("unknown app 12 1个月"), envFixture());
    const body = await readSuccessData<{ subscriptions: Array<{ notes: unknown; warnings: string[] }> }>(response);

    expect(aiMocks.generateObject).toHaveBeenCalledTimes(1);
    expect(body.subscriptions[0]?.notes).toBeNull();
    expect(body.subscriptions[0]?.warnings).toEqual(expect.arrayContaining(["AI_WARNING_WEBSITE_UNCERTAIN", "AI_WARNING_LOW_CONFIDENCE"]));
  });

  it("recovers non-stream drafts from raw JSON when structured output rejects nullable website values", async () => {
    const rawObject = {
      subscriptions: [generatedDraft({
        name: "LocVPS",
        website: { value: null, source: "suggested" },
        notes: { value: "LocVPS 是提供 VPS 和云主机相关产品或服务的订阅服务。", source: "suggested" },
        tags: ["VPS", "云主机"],
      })],
      warnings: [],
    };
    aiMocks.generateObject.mockRejectedValue(noObjectGeneratedErrorWithText([
      "```json",
      JSON.stringify(rawObject, null, 2),
      "```",
      "sk-raw-secret123",
    ].join("\n")));

    const response = await recognizeSubscriptions(requestForText("locvps 20元 1个月"), envFixture());
    const body = await readSuccessData<{
      subscriptions: Array<{ name: string; website: unknown }>;
      diagnostics: { output: { rawModelText: { value: string } | null; rawObjectJson: { value: string } | null } };
    }>(response);
    const payload = JSON.stringify(body);

    expect(body.subscriptions[0]).toMatchObject({ name: "LocVPS", website: null });
    expect(body.diagnostics.output.rawObjectJson?.value).toContain("\"name\": \"LocVPS\"");
    expect(payload).not.toContain("sk-raw-secret123");
    expect(payload).toContain("[redacted]");
  });

  it("returns an actionable error when the provider object cannot be parsed", async () => {
    const providerError = Object.assign(new Error("No object generated: response did not match schema."), {
      __noObjectGenerated: true,
      text: "not json sk-test-secret",
      usage: { inputTokens: 10, outputTokens: 3 },
      finishReason: "stop",
    });
    aiMocks.generateObject.mockRejectedValue(providerError);

    await expect(recognizeSubscriptions(requestForText("dmit 15元 1个月"), envFixture())).rejects.toMatchObject({
      status: 400,
      code: "AI_RECOGNITION_SCHEMA_MISMATCH",
      message: "AI 返回内容无法整理成订阅草稿，请换用更强的模型或补充更明确的价格、周期和名称。",
      details: {
        rawResponseText: expect.stringContaining("No object generated"),
      },
    });
  });

  it("returns raw provider response details when non-stream recognition provider call fails", async () => {
    aiMocks.generateObject.mockRejectedValue(Object.assign(new Error("provider rejected sk-test-secret"), {
      __apiCallError: true,
      statusCode: 403,
      responseHeaders: { "content-type": "application/json" },
      responseBody: "{\"error\":\"forbidden sk-test-secret\"}",
    }));

    await expect(recognizeSubscriptions(requestForText("dmit 15元 1个月"), envFixture())).rejects.toMatchObject({
      status: 400,
      code: "AI_RECOGNITION_FAILED",
      details: {
        rawResponseText: "{\"error\":\"forbidden [redacted]\"}",
      },
    });
  });

});
