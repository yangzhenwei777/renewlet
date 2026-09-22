import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api-client";
import type { AiRecognitionSettings } from "@/lib/api/schemas/ai-recognition";
import { DEFAULT_SETTINGS } from "@/types/subscription";
import { aiRecognitionService } from "@/services/ai-recognition-service";
import { AIRecognitionSettingsSection } from "./ai-recognition-settings-section";

const mocks = vi.hoisted(() => ({
  listModels: vi.fn(),
  testConnection: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: mocks.toast,
}));

vi.mock("@/services/ai-recognition-service", () => ({
  aiRecognitionService: {
    listModels: mocks.listModels,
    testConnection: mocks.testConnection,
  },
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        "aiRecognition.apiKey": "API Key",
        "aiRecognition.apiKeyHelp": "用于访问模型 provider。",
        "aiRecognition.apiKeyOptionalPlaceholder": "可选",
        "aiRecognition.apiKeyRequired": "请先填写 API Key。",
        "aiRecognition.baseUrl": "Base URL",
        "aiRecognition.baseUrlHelp": "官方平台可留空；OpenAI Compatible 填写对应的 OpenAI Chat Base URL。",
        "aiRecognition.baseUrlPlaceholder": "默认地址",
        "aiRecognition.baseUrlRequired": "OpenAI Compatible 需要填写 Base URL。",
        "aiRecognition.defaultThinking": "默认思考控制",
        "aiRecognition.errorDetailsDescription": "接口返回的原始响应。",
        "aiRecognition.errorDetailsOpenLast": "查看上次响应",
        "aiRecognition.errorDetailsTitle": "AI 错误详情",
        "rawErrorResponse.copy": "复制错误详情",
        "rawErrorResponse.copied": "已复制",
        "rawErrorResponse.copyFailed": "复制失败",
        "rawErrorResponse.responseUnavailable": "当前错误没有可回显的响应正文。",
        "aiRecognition.model": "模型",
        "aiRecognition.modelListFailedDescription": "无法获取模型列表，请检查 Base URL 和 API Key，或手动输入模型 ID。",
        "aiRecognition.modelListLoading": "正在获取模型列表...",
        "aiRecognition.modelListTruncated": "模型列表较长，仅显示前 300 个结果；可继续搜索或手动输入。",
        "aiRecognition.modelMode": "模型输入方式",
        "aiRecognition.modelModeManual": "手动输入",
        "aiRecognition.modelModeSelect": "选择模型",
        "aiRecognition.modelPlaceholder": "输入模型",
        "aiRecognition.modelSelectEmpty": "没有可选择的模型。请确认 Base URL / API Key 已填写，或切换到手动输入。",
        "aiRecognition.modelSelectPlaceholder": "选择模型",
        "aiRecognition.modelSelectSearchPlaceholder": "搜索模型",
        "aiRecognition.providerType": "平台类型",
        "aiRecognition.providerType.anthropic": "Claude",
        "aiRecognition.providerType.gemini": "Gemini",
        "aiRecognition.providerType.openai": "OpenAI",
        "aiRecognition.providerType.openaiCompatible": "OpenAI Compatible",
        "aiRecognition.settingsDescription": "配置用于识别订阅图片、备忘录或表格文本的第三方模型。",
        "aiRecognition.settingsTitle": "AI 识别",
        "aiRecognition.testConnection": "测试连接",
        "aiRecognition.testFailedDescription": "无法完成测试调用，请检查模型、Base URL 和 API Key。",
        "aiRecognition.testing": "测试中...",
        "aiRecognition.thinking.modelDefault": "模型默认",
        "aiRecognition.thinkingHelp": "仅展示当前平台和模型明确支持的官方思考控制。",
        "aiRecognition.thinkingUnsupportedCompatible": "OpenAI Compatible 没有统一 thinking 标准。",
        "aiRecognition.thinkingUnsupportedModel": "当前模型未匹配到官方 thinking 能力。",
        "common.close": "关闭",
      };
      return messages[key] ?? key;
    },
  }),
}));

function aiModelListApiError(body = "{\"code\":\"INVALID_API_KEY\",\"message\":\"Invalid API key\"}") {
  const rawResponse = `{"error":{"message":"无法获取模型列表，请检查 Base URL 和 API Key，或手动输入模型 ID。","code":"AI_MODEL_LIST_FAILED","details":{"rawResponseText":${JSON.stringify(body)}}}}`;
  return new ApiError(
    "无法获取模型列表，请检查 Base URL 和 API Key，或手动输入模型 ID。",
    401,
    {
      rawResponseText: body,
    },
    "AI_MODEL_LIST_FAILED",
    rawResponse,
  );
}

function renderAIRecognitionSection({
  initialSettings,
  onChange = vi.fn(),
  disabled = false,
}: {
  initialSettings?: Partial<AiRecognitionSettings>;
  onChange?: (settings: AiRecognitionSettings) => void;
  disabled?: boolean;
} = {}) {
  function StatefulSection() {
    const [settings, setSettings] = useState<AiRecognitionSettings>({
      ...DEFAULT_SETTINGS.aiRecognition,
      providerType: "anthropic",
      transportProtocol: "anthropic-messages",
      model: "claude-sonnet-4-6",
      modelInputMode: "manual",
      apiKey: "anthropic-key",
      ...initialSettings,
    });

    return (
      <TooltipProvider delayDuration={0}>
        <AIRecognitionSettingsSection
          id="settings-ai-recognition"
          settings={settings}
          onChange={(nextSettings) => {
            setSettings(nextSettings);
            onChange(nextSettings);
          }}
          disabled={disabled}
        />
      </TooltipProvider>
    );
  }

  return render(<StatefulSection />);
}

describe("AIRecognitionSettingsSection provider model layout", () => {
  beforeEach(() => {
    mocks.listModels.mockReset();
    mocks.testConnection.mockReset();
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
    Element.prototype.hasPointerCapture ??= vi.fn(() => false);
    Element.prototype.releasePointerCapture ??= vi.fn();
  });

  it("uses shared label and control tracks for provider, model and credentials", () => {
    renderAIRecognitionSection();

    const fieldGrid = screen.getByTestId("ai-provider-model-grid");
    const providerField = screen.getByRole("combobox", { name: "平台类型" }).closest('[data-slot="form-field"]');
    const modelField = screen.getByRole("textbox", { name: "模型" }).closest('[data-slot="form-field"]');
    const providerLabelRow = providerField?.querySelector('[data-slot="form-field-label"]');
    const modelLabelRow = screen.getByTestId("ai-model-label-row");
    const providerControlRow = providerField?.querySelector('[data-slot="form-field-control"]');
    const modelControlRow = modelField?.querySelector('[data-slot="form-field-control"]');
    const modeSwitch = screen.getByTestId("ai-model-mode-switch");

    expect(fieldGrid).toHaveAttribute("data-align-at", "md");
    expect(fieldGrid).toHaveAttribute("data-tracks", "2");
    expect(fieldGrid.firstElementChild).toHaveClass("md:grid-cols-2", "md:gap-x-5");
    expect(providerField).toHaveClass("md:row-span-2", "md:grid-rows-subgrid");
    expect(modelField).toHaveClass("md:row-span-2", "md:grid-rows-subgrid");
    expect(providerLabelRow).toHaveClass("md:self-end");
    expect(modelLabelRow).toHaveClass("min-h-7");
    expect(providerControlRow).toHaveClass("self-start");
    expect(modelControlRow).toHaveClass("self-start");
    expect(modeSwitch).not.toHaveClass("absolute");
    expect(within(providerLabelRow as HTMLElement).getByText("平台类型")).toBeInTheDocument();
    expect(within(modelLabelRow).getByText("模型")).toBeInTheDocument();
    expect(screen.queryByText("接口协议")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "模型" })).toHaveValue("claude-sonnet-4-6");

    const credentialsRow = screen.getByLabelText("Base URL").closest('[data-slot="form-field-row"]');
    expect(credentialsRow).toHaveAttribute("data-align-at", "md");
    expect(credentialsRow).toHaveAttribute("data-tracks", "3");
    expect(screen.getByLabelText("Base URL")).toHaveAttribute("aria-describedby", "ai-base-url-description");
    expect(screen.getByLabelText("API Key")).toHaveAttribute("aria-describedby", "ai-api-key-description");
  });

  it("requests models when switching to select mode with credentials available", async () => {
    const user = userEvent.setup();
    mocks.listModels.mockResolvedValueOnce({ models: [], truncated: false });
    const onChange = vi.fn();
    renderAIRecognitionSection({ onChange });

    await user.click(screen.getByRole("button", { name: "选择模型" }));

    await waitFor(() => {
      expect(aiRecognitionService.listModels).toHaveBeenCalledWith({
        providerType: "anthropic",
        baseUrl: "",
        apiKey: { action: "set", value: "anthropic-key" },
      });
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ modelInputMode: "select" }));
  });

  it("disables provider credentials, test and model refresh controls when requested", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderAIRecognitionSection({
      onChange,
      disabled: true,
      initialSettings: { modelInputMode: "select" },
    });

    expect(screen.getByRole("combobox", { name: "平台类型" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "模型" })).toBeDisabled();
    expect(screen.getByLabelText("Base URL")).toBeDisabled();
    expect(screen.getByLabelText("API Key")).toBeDisabled();
    expect(screen.getByRole("button", { name: "测试连接" })).toBeDisabled();

    await user.click(screen.getByRole("combobox", { name: "模型" }));

    expect(aiRecognitionService.listModels).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("derives hidden protocol when provider type changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderAIRecognitionSection({ onChange });

    await user.click(screen.getByRole("combobox", { name: "平台类型" }));
    await user.click(await screen.findByRole("option", { name: "Gemini" }));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      providerType: "gemini",
      transportProtocol: "gemini-generate-content",
      defaultThinkingControl: null,
    }));
  });

  it("opens provider response details when model loading fails", async () => {
    const user = userEvent.setup();
    mocks.listModels.mockRejectedValueOnce(aiModelListApiError());
    renderAIRecognitionSection();

    await user.click(screen.getByRole("button", { name: "选择模型" }));

    const detailsDialog = await screen.findByRole("dialog", { name: "AI 错误详情" });
    const fixedDialogClass = "h-[min(calc(var(--app-viewport-height)-2rem),42rem)]";
    expect(detailsDialog).toHaveClass(fixedDialogClass);
    expect(detailsDialog).not.toHaveClass("h-fit");
    expect(detailsDialog).toHaveTextContent("INVALID_API_KEY");
    expect(detailsDialog).toHaveTextContent("Invalid API key");
    expect(detailsDialog).not.toHaveTextContent("AI_MODEL_LIST_FAILED");
    expect(detailsDialog).not.toHaveTextContent("rawResponseText");
  });

  it("keeps last provider response entry after switching back to manual input", async () => {
    const user = userEvent.setup();
    mocks.listModels.mockRejectedValueOnce(aiModelListApiError("invalid provider response"));
    renderAIRecognitionSection();

    await user.click(screen.getByRole("button", { name: "选择模型" }));
    expect(await screen.findByRole("dialog", { name: "AI 错误详情" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭" }));

    expect(screen.getByRole("button", { name: "查看上次响应" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "手动输入" }));

    expect(screen.getByRole("button", { name: "查看上次响应" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "模型" })).toBeInTheDocument();
  });

  it("opens provider response details instead of toast when connection test fails", async () => {
    const user = userEvent.setup();
    mocks.testConnection.mockRejectedValueOnce(new ApiError(
      "AI 连接失败",
      400,
      {
        rawResponseText: "{\"error\":\"forbidden\"}",
      },
      "AI_RECOGNITION_TEST_FAILED",
      "{\"error\":{\"message\":\"AI 连接失败\",\"code\":\"AI_RECOGNITION_TEST_FAILED\",\"details\":{\"rawResponseText\":\"{\\\"error\\\":\\\"forbidden\\\"}\"}}}",
    ));
    renderAIRecognitionSection();

    await user.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByRole("dialog", { name: "AI 错误详情" })).toBeInTheDocument();
    expect(screen.getByText(/forbidden/)).toBeInTheDocument();
    expect(screen.queryByText(/AI_RECOGNITION_TEST_FAILED/)).not.toBeInTheDocument();
    expect(screen.queryByText(/rawResponseText/)).not.toBeInTheDocument();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
});
