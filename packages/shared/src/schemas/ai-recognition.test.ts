// AI 识别 schema 测试保护生成态、最终态、SSE 态三层契约，避免 Docker/Worker/前端导入边界混用。
import { describe, expect, it } from "vitest";
import {
  isAIProviderBaseUrlRequired,
  resolveAIProviderEndpoint,
} from "../ai-provider-endpoints";
import { aiRecognitionPromptSpec } from "../ai-recognition-prompt";
import {
  AI_RECOGNITION_MAX_IMAGES,
  aiGeneratedRecognizeObjectSchema,
  aiModelListErrorDetailsSchema,
  aiModelListRequestSchema,
  aiModelListResponseSchema,
  aiRecognitionDiagnosticsSchema,
  aiRecognitionErrorDetailsSchema,
  aiRecognitionSettingsSchema,
  aiRecognitionStreamEventSchema,
  aiRecognizeResponseSchema,
} from "./ai-recognition";

const success = <T>(data: T) => ({ ok: true, data });

function generatedDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // generated fixture 故意模拟模型原始对象，而不是最终导入草稿；nullable 和 notes 决策在这里被重点覆盖。
  return {
    name: "youtube",
    price: 15,
    currency: "USD",
    billingCycle: "annual",
    customDays: null,
    customCycleUnit: null,
    oneTimeTermCount: null,
    oneTimeTermUnit: null,
    category: "entertainment",
    status: "active",
    paymentMethod: null,
    startDate: null,
    nextBillingDate: null,
    autoCalculateNextBillingDate: true,
    trialEndDate: null,
    website: { value: "https://www.youtube.com/", source: "suggested" },
    notes: { value: "YouTube 是 Google 旗下的视频分享和流媒体平台。", source: "suggested" },
    tags: ["流媒体"],
    reminderDays: null,
    repeatReminderEnabled: null,
    repeatReminderInterval: null,
    repeatReminderWindow: null,
    confidence: "high",
    warnings: [],
    ...overrides,
  };
}

describe("AI recognition generated schema", () => {
  it("allows nullable generated website values while keeping final responses strict", () => {
    expect(aiGeneratedRecognizeObjectSchema.safeParse({
      subscriptions: [generatedDraft({ website: { value: null, source: "suggested" } })],
      warnings: [],
    }).success).toBe(true);
  });

  it("requires complete draft fields and a notes decision object", () => {
    expect(aiGeneratedRecognizeObjectSchema.safeParse({
      subscriptions: [generatedDraft()],
      warnings: [],
    }).success).toBe(true);

    const withoutNotes = generatedDraft();
    delete withoutNotes["notes"];
    expect(aiGeneratedRecognizeObjectSchema.safeParse({
      subscriptions: [withoutNotes],
      warnings: [],
    }).success).toBe(false);

    expect(aiGeneratedRecognizeObjectSchema.safeParse({
      subscriptions: [generatedDraft({ notes: {} })],
      warnings: [],
    }).success).toBe(false);

    expect(aiGeneratedRecognizeObjectSchema.safeParse({
      subscriptions: [generatedDraft({ notes: null })],
      warnings: [],
    }).success).toBe(false);

    expect(aiGeneratedRecognizeObjectSchema.safeParse({
      subscriptions: [generatedDraft({ notes: { value: null, source: "none" } })],
      warnings: [],
    }).success).toBe(true);
  });

  it("requires top-level warnings and draft warning arrays", () => {
    expect(aiGeneratedRecognizeObjectSchema.safeParse({
      subscriptions: [generatedDraft()],
    }).success).toBe(false);

    const withoutDraftWarnings = generatedDraft();
    delete withoutDraftWarnings["warnings"];
    expect(aiGeneratedRecognizeObjectSchema.safeParse({
      subscriptions: [withoutDraftWarnings],
      warnings: [],
    }).success).toBe(false);
  });

  it("limits generated tags to a small reusable set", () => {
    expect(aiGeneratedRecognizeObjectSchema.safeParse({
      subscriptions: [generatedDraft({ tags: ["VPS", "云服务器", "流媒体"] })],
      warnings: [],
    }).success).toBe(true);

    expect(aiGeneratedRecognizeObjectSchema.safeParse({
      subscriptions: [generatedDraft({ tags: ["VPS", "云服务器", "流媒体", "Debian 12"] })],
      warnings: [],
    }).success).toBe(false);
  });
});

describe("AI recognition prompt contract", () => {
  it("tells models to use whole-field null for unknown websites", () => {
    const promptText = [
      ...aiRecognitionPromptSpec.outputContract,
      ...aiRecognitionPromptSpec.fieldRules,
    ].join("\n");

    expect(promptText).toContain("website: null");
    expect(promptText).toContain("never output {\"value\": null, \"source\": \"suggested\"}");
  });

  it("tells models not to infer unknown recurring start dates", () => {
    const promptText = aiRecognitionPromptSpec.fieldRules.join("\n");

    expect(promptText).toContain("Recurring subscriptions may use startDate: null");
    expect(promptText).toContain("If startDate is null, set autoCalculateNextBillingDate to false");
  });

  it("requires strict JSON and nulls for unknown billing facts", () => {
    const promptText = [
      ...aiRecognitionPromptSpec.system,
      ...aiRecognitionPromptSpec.outputContract,
      ...aiRecognitionPromptSpec.fieldRules,
    ].join("\n");

    expect(aiRecognitionPromptSpec.version).toBe("2026-06-24.strict-null-json");
    expect(promptText).toContain("parseable by JSON.parse");
    expect(promptText).toContain("Every field listed above must be present exactly once");
    expect(promptText).toContain("If a billing fact is absent, hidden, unreadable, ambiguous, or inferred only from context, output null");
    expect(promptText).toContain("Never invent price, currency, billing cycle, dates, status, payment method, or reminder fields");
    expect(promptText).toContain("If the amount itself is uncertain or unreadable, set both price and currency to null");
    expect(promptText).toContain("If the cycle is not explicit, output billingCycle: null");
    expect(promptText).toContain("Do not calculate nextBillingDate unless the input explicitly provides enough billing anchor evidence");
    expect(promptText).toContain("Do not default to active unless the input clearly shows the subscription is currently active");
  });
});

describe("AI recognition diagnostics schema", () => {
  it("allows five image metadata entries and rejects more", () => {
    // diagnostics 只记录图片元数据，不回传 base64；数量上限同时保护 Worker 内存和脱敏响应大小。
    const diagnostics = {
      schemaVersion: "1",
      promptVersion: "test",
      schemaName: "renewlet_ai_subscription_recognition",
      prompt: {
        system: { value: "system", truncated: false },
        user: { value: "user", truncated: false },
      },
      output: {
        rawModelText: null,
        rawObjectJson: null,
      },
      request: {
        providerType: "openai",
        transportProtocol: "openai-chat",
        model: "gpt-5.1",
        thinkingControl: null,
        maxOutputTokens: 12000,
        textCharCount: 0,
        images: Array.from({ length: AI_RECOGNITION_MAX_IMAGES }, () => ({ mediaType: "image/png", sizeBytes: 4 })),
      },
      response: {
        usage: null,
        finishReason: null,
        providerMetadata: null,
      },
    };

    expect(aiRecognitionDiagnosticsSchema.safeParse(diagnostics).success).toBe(true);
    expect(aiRecognitionDiagnosticsSchema.safeParse({
      ...diagnostics,
      request: {
        ...diagnostics.request,
        images: [...diagnostics.request.images, { mediaType: "image/png", sizeBytes: 4 }],
      },
    }).success).toBe(false);
  });
});

describe("AI provider error response schema", () => {
  it("keeps raw provider response text for model list failures", () => {
    const rawBody = "  {\"error\":\"invalid sk-test-secret\"}\n";
    expect(aiModelListErrorDetailsSchema.parse({
      rawResponseText: rawBody,
    }).rawResponseText).toBe(rawBody);

    expect(aiModelListErrorDetailsSchema.safeParse({
      reason: "http_401",
      providerMessage: "legacy provider message",
    }).success).toBe(false);
  });

  it("allows AI recognition errors to expose only raw response text", () => {
    expect(aiRecognitionErrorDetailsSchema.safeParse({
      rawResponseText: "{\"error\":\"invalid model\"}",
    }).success).toBe(true);
  });
});

describe("AI recognition final response schema", () => {
  it("rejects generated-only nullable website objects after normalization boundary", () => {
    // 生成态允许模型表达“不确定”，最终 API 必须在进入导入预览前完成归一化。
    const diagnostics = {
      schemaVersion: "1",
      promptVersion: "test",
      schemaName: "renewlet_ai_subscription_recognition",
      prompt: {
        system: { value: "system", truncated: false },
        user: { value: "user", truncated: false },
      },
      output: {
        rawModelText: null,
        rawObjectJson: null,
      },
      request: {
        providerType: "openai",
        transportProtocol: "openai-chat",
        model: "gpt-5.1",
        thinkingControl: null,
        maxOutputTokens: 12000,
        textCharCount: 12,
        images: [],
      },
      response: {
        usage: null,
        finishReason: null,
        providerMetadata: null,
      },
    };

    expect(aiRecognizeResponseSchema.safeParse(success({
      providerType: "openai",
      transportProtocol: "openai-chat",
      model: "gpt-5.1",
      subscriptions: [generatedDraft({ website: { value: null, source: "suggested" } })],
      warnings: [],
      diagnostics,
    })).success).toBe(false);
  });
});

describe("AI recognition stream event schema", () => {
  it("accepts progress, partial, text, reasoning and final stream events", () => {
    // final 事件是唯一可进入导入草稿的事实源，其它事件只服务 UI 进度和排障提示。
    const diagnostics = {
      schemaVersion: "1",
      promptVersion: "test",
      schemaName: "renewlet_ai_subscription_recognition",
      prompt: {
        system: { value: "system", truncated: false },
        user: { value: "user", truncated: false },
      },
      output: {
        rawModelText: null,
        rawObjectJson: null,
      },
      request: {
        providerType: "openai",
        transportProtocol: "openai-chat",
        model: "gpt-5.1",
        thinkingControl: null,
        maxOutputTokens: 12000,
        textCharCount: 12,
        images: [],
      },
      response: {
        usage: null,
        finishReason: null,
        providerMetadata: null,
      },
    };
    const response = {
      providerType: "openai",
      transportProtocol: "openai-chat",
      model: "gpt-5.1",
      subscriptions: [generatedDraft({ price: "15" })],
      warnings: [],
      diagnostics,
    };

    expect(aiRecognitionStreamEventSchema.safeParse({ type: "recognition/progress", stage: "model-start" }).success).toBe(true);
    expect(aiRecognitionStreamEventSchema.safeParse({ type: "recognition/partial", subscriptionsSeen: 1, warningsSeen: 0 }).success).toBe(true);
    expect(aiRecognitionStreamEventSchema.safeParse({ type: "recognition/text-delta", delta: "{\"subscriptions\"" }).success).toBe(true);
    expect(aiRecognitionStreamEventSchema.safeParse({ type: "recognition/reasoning-delta", delta: "checking rows" }).success).toBe(true);
    expect(aiRecognitionStreamEventSchema.safeParse({ type: "recognition/final", response }).success).toBe(true);
  });

  it("rejects unexpected stream event fields and invalid stages", () => {
    expect(aiRecognitionStreamEventSchema.safeParse({
      type: "recognition/progress",
      stage: "fake-thinking",
    }).success).toBe(false);

    expect(aiRecognitionStreamEventSchema.safeParse({
      type: "recognition/partial",
      subscriptionsSeen: 1,
      warningsSeen: 0,
      rawObjectJson: "{}",
    }).success).toBe(false);
  });
});

describe("AI model list schema", () => {
  it("accepts normalized provider model list items", () => {
    expect(aiModelListRequestSchema.parse({
      providerType: "gemini",
      baseUrl: "",
      apiKey: { action: "set", value: "AIza-test-key" },
    })).toEqual({
      providerType: "gemini",
      baseUrl: "",
      apiKey: { action: "set", value: "AIza-test-key" },
    });

    expect(aiModelListResponseSchema.safeParse(success({
      providerType: "gemini",
      transportProtocol: "gemini-generate-content",
      models: [{
        id: "gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        createdAt: null,
        ownedBy: null,
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        capabilities: {
          textInput: true,
          imageInput: null,
          structuredOutput: null,
          thinking: true,
        },
      }],
      truncated: false,
    })).success).toBe(true);
  });

  it("rejects model list payloads with unexpected fields", () => {
    expect(aiModelListRequestSchema.safeParse({
      providerType: "openai",
      baseUrl: "",
      apiKey: { action: "keep" },
      model: "gpt-5.1",
    }).success).toBe(false);

    expect(aiModelListResponseSchema.safeParse(success({
      providerType: "openai",
      transportProtocol: "openai-chat",
      models: [{
        id: "gpt-5.1",
        displayName: null,
        createdAt: null,
        ownedBy: null,
        inputTokenLimit: null,
        outputTokenLimit: null,
        capabilities: {
          textInput: null,
          imageInput: null,
          structuredOutput: null,
          thinking: null,
          hidden: true,
        },
      }],
      truncated: false,
    })).success).toBe(false);
  });
});

describe("AI recognition settings schema", () => {
  it("defaults the model input mode to select for existing settings", () => {
    expect(aiRecognitionSettingsSchema.parse({
      providerType: "openai",
      transportProtocol: "openai-chat",
      model: "gpt-5.1",
      baseUrl: "",
      apiKey: "sk-test",
      defaultThinkingControl: null,
    }).modelInputMode).toBe("select");

    expect(aiRecognitionSettingsSchema.parse({
      providerType: "openai",
      transportProtocol: "openai-chat",
      model: "custom-model",
      modelInputMode: "manual",
      baseUrl: "",
      apiKey: "sk-test",
      defaultThinkingControl: null,
    }).modelInputMode).toBe("manual");
  });

  it("normalizes old provider settings at the settings boundary only", () => {
    expect(aiRecognitionSettingsSchema.parse({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      baseUrl: "",
      apiKey: "sk-ant-test",
      defaultThinkingControl: null,
    })).toMatchObject({
      providerType: "anthropic",
      transportProtocol: "anthropic-messages",
      modelInputMode: "select",
    });
  });

  it("canonicalizes missing and mismatched transport protocol from provider type", () => {
    expect(aiRecognitionSettingsSchema.parse({
      providerType: "gemini",
      model: "gemini-2.5-pro",
      baseUrl: "",
      apiKey: "AIza-test",
      defaultThinkingControl: null,
    })).toMatchObject({
      providerType: "gemini",
      transportProtocol: "gemini-generate-content",
    });

    expect(aiRecognitionSettingsSchema.parse({
      providerType: "openai-compatible",
      transportProtocol: "anthropic-messages",
      model: "custom-model",
      modelInputMode: "manual",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "",
      defaultThinkingControl: { provider: "anthropic", mode: "effort", effort: "high" },
    })).toMatchObject({
      providerType: "openai-compatible",
      transportProtocol: "openai-chat",
      defaultThinkingControl: null,
    });
  });
});

describe("AI provider endpoint resolver", () => {
  it("normalizes runtime and model-list endpoints by transport protocol", () => {
    expect(resolveAIProviderEndpoint({
      providerType: "openai",
      baseUrl: "https://api.example.com/openai/v1/chat/completions",
      apiKey: "sk-test",
    })).toMatchObject({
      runtimeBaseUrl: "https://api.example.com/openai/v1",
      modelsUrl: "https://api.example.com/openai/v1/models",
      modelListShape: "openai",
      authHeaders: { authorization: "Bearer sk-test" },
    });

    expect(resolveAIProviderEndpoint({
      providerType: "anthropic",
      baseUrl: "https://claude.example.com/messages",
      apiKey: "sk-ant-test",
    })).toMatchObject({
      runtimeBaseUrl: "https://claude.example.com/v1",
      modelsUrl: "https://claude.example.com/v1/models",
      modelListShape: "anthropic",
      authHeaders: { "x-api-key": "sk-ant-test", "anthropic-version": "2023-06-01" },
    });

    expect(resolveAIProviderEndpoint({
      providerType: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent?key=bad",
      apiKey: "AIza-test",
    })).toMatchObject({
      runtimeBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
      modelsUrl: "https://generativelanguage.googleapis.com/v1beta/models",
      modelListShape: "gemini",
      authHeaders: { "x-goog-api-key": "AIza-test" },
    });
  });

  it("uses # to disable automatic version appending", () => {
    expect(resolveAIProviderEndpoint({
      providerType: "openai-compatible",
      baseUrl: "https://gateway.example.com/custom/api#",
      apiKey: "",
    })).toMatchObject({
      runtimeBaseUrl: "https://gateway.example.com/custom/api",
      modelsUrl: "https://gateway.example.com/custom/api/models",
      authHeaders: {},
      baseUrlRequired: true,
      apiKeyRequired: false,
    });
  });

  it("requires base URL only when no official default matches the selected protocol", () => {
    expect(isAIProviderBaseUrlRequired("openai")).toBe(false);
    expect(isAIProviderBaseUrlRequired("anthropic")).toBe(false);
    expect(isAIProviderBaseUrlRequired("gemini")).toBe(false);
    expect(isAIProviderBaseUrlRequired("openai-compatible")).toBe(true);
  });

  it("overrides mismatched transport protocol before URL, auth and response shape resolution", () => {
    expect(resolveAIProviderEndpoint({
      providerType: "openai-compatible",
      transportProtocol: "gemini-generate-content",
      baseUrl: "https://gateway.example.com/custom/api#",
      apiKey: "custom-key",
    })).toMatchObject({
      transportProtocol: "openai-chat",
      runtimeBaseUrl: "https://gateway.example.com/custom/api",
      modelsUrl: "https://gateway.example.com/custom/api/models",
      modelListShape: "openai",
      authHeaders: { authorization: "Bearer custom-key" },
    });
  });
});
