import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AiModelListItem } from "@/lib/api/schemas/ai-recognition";
import { AIModelCombobox, AIModelModeSwitch } from "./ai-model-combobox";

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        "aiRecognition.model": "模型",
        "aiRecognition.modelMode": "模型输入方式",
        "aiRecognition.modelModeManual": "手动输入",
        "aiRecognition.modelModeSelect": "选择模型",
        "aiRecognition.modelPlaceholder": "输入模型",
        "aiRecognition.modelSelectEmpty": "没有可选择的模型。请确认 Base URL / API Key 已填写，或切换到手动输入。",
        "aiRecognition.modelSelectPlaceholder": "选择模型",
        "aiRecognition.modelSelectSearchPlaceholder": "搜索模型",
        "aiRecognition.modelListLoading": "正在获取模型列表...",
        "aiRecognition.modelListTruncated": "模型列表较长，仅显示前 300 个结果；可继续搜索或手动输入。",
      };
      return messages[key] ?? key;
    },
  }),
}));

const models: AiModelListItem[] = [
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    createdAt: null,
    ownedBy: "openai",
    inputTokenLimit: null,
    outputTokenLimit: null,
    capabilities: { textInput: null, imageInput: null, structuredOutput: null, thinking: null },
  },
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    createdAt: null,
    ownedBy: "openai",
    inputTokenLimit: null,
    outputTokenLimit: null,
    capabilities: { textInput: null, imageInput: null, structuredOutput: null, thinking: null },
  },
  {
    id: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    createdAt: null,
    ownedBy: "openai",
    inputTokenLimit: null,
    outputTokenLimit: null,
    capabilities: { textInput: null, imageInput: null, structuredOutput: null, thinking: null },
  },
  {
    id: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    createdAt: null,
    ownedBy: null,
    inputTokenLimit: 1048576,
    outputTokenLimit: 65536,
    capabilities: { textInput: true, imageInput: null, structuredOutput: null, thinking: true },
  },
];

function renderCombobox(props: Partial<ComponentProps<typeof AIModelCombobox>> = {}) {
  const {
    value: initialValue = "gpt-5.5",
    onValueChange = vi.fn(),
    mode: initialMode = "select",
    ...restProps
  } = props;

  function StatefulCombobox() {
    const [currentValue, setCurrentValue] = useState(initialValue);
    return (
      <TooltipProvider delayDuration={0}>
        <AIModelCombobox
          id="ai-model"
          value={currentValue}
          onValueChange={(nextValue) => {
            setCurrentValue(nextValue);
            onValueChange(nextValue);
          }}
          mode={initialMode}
          models={models}
          status="success"
          error={null}
          truncated={false}
          canAutoRefreshModels
          onRequestModels={vi.fn()}
          placeholder="输入模型"
          {...restProps}
        />
      </TooltipProvider>
    );
  }

  return render(<StatefulCombobox />);
}

describe("AIModelCombobox", () => {
  it("does not render a separate refresh button", () => {
    renderCombobox();

    expect(screen.queryByRole("button", { name: "刷新" })).not.toBeInTheDocument();
  });

  it("requests models automatically when opening the default select dropdown", async () => {
    const user = userEvent.setup();
    const onRequestModels = vi.fn();
    renderCombobox({
      value: "",
      models: [],
      status: "idle",
      canAutoRefreshModels: true,
      onRequestModels,
    });

    await user.click(screen.getByRole("combobox", { name: "模型" }));

    expect(onRequestModels).toHaveBeenCalledTimes(1);
  });

  it("defaults to select mode", () => {
    renderCombobox({ value: "" });

    expect(screen.getByRole("combobox", { name: "模型" })).toBeInTheDocument();
  });

  it("writes custom model ids directly in manual mode", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderCombobox({ value: "", mode: "manual", models: [], onValueChange });

    const input = screen.getByRole("textbox", { name: "模型" });
    await user.type(input, "custom-model");

    expect(input).toHaveValue("custom-model");
    expect(onValueChange).toHaveBeenLastCalledWith("custom-model");
    expect(screen.queryByText(/使用自定义模型/)).not.toBeInTheDocument();
  });

  it("hides model list feedback in manual mode", () => {
    renderCombobox({
      mode: "manual",
      value: "custom-model",
      models: [],
      status: "success",
      error: "无法获取模型列表",
      truncated: true,
    });

    expect(screen.getByRole("textbox", { name: "模型" })).toHaveValue("custom-model");
    expect(screen.queryByText("无法获取模型列表")).not.toBeInTheDocument();
    expect(screen.queryByText("模型列表较长，仅显示前 300 个结果；可继续搜索或手动输入。")).not.toBeInTheDocument();
  });

  it("renders the mode switch as a normal-flow segmented control", () => {
    render(<AIModelModeSwitch mode="select" onModeChange={vi.fn()} />);

    const modeSwitch = screen.getByRole("group", { name: "模型输入方式" });
    const modeButtons = within(modeSwitch).getAllByRole("button");

    const manualButton = screen.getByRole("button", { name: "手动输入" });
    const selectButton = screen.getByRole("button", { name: "选择模型" });

    expect(modeButtons.map((button) => button.textContent)).toEqual(["选择模型", "手动输入"]);
    expect(modeSwitch).toHaveClass("h-7");
    expect(modeSwitch).toHaveClass("rounded-md");
    expect(modeSwitch).toHaveClass("bg-secondary/30");
    expect(modeSwitch).not.toHaveClass("absolute");
    expect(modeSwitch).not.toHaveClass("border");
    expect(modeSwitch).not.toHaveClass("bg-secondary/50");
    expect(screen.queryByText("/")).not.toBeInTheDocument();
    expect(selectButton).toHaveAttribute("aria-pressed", "true");
    expect(selectButton).toHaveClass("bg-secondary");
    expect(selectButton).toHaveClass("text-foreground");
    expect(manualButton).toHaveClass("focus-visible:ring-1");
    expect(manualButton).not.toHaveClass("underline");
    expect(manualButton).not.toHaveClass("decoration-border");
    expect(manualButton).not.toHaveClass("focus:ring-2");
    expect(manualButton).not.toHaveClass("focus:ring-ring");
    expect(manualButton).not.toHaveClass("bg-primary");
    expect(manualButton).not.toHaveClass("border-primary");
    expect(manualButton).not.toHaveClass("text-primary");
    expect(manualButton).toHaveClass("hover:bg-secondary/60");
  });

  it("calls mode changes from the mode switch", async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();
    render(<AIModelModeSwitch mode="manual" onModeChange={onModeChange} />);

    await user.click(screen.getByRole("button", { name: "选择模型" }));
    await user.click(screen.getByRole("button", { name: "手动输入" }));

    expect(onModeChange).toHaveBeenNthCalledWith(1, "select");
    expect(onModeChange).toHaveBeenNthCalledWith(2, "manual");
  });

  it("renders disabled mode buttons", () => {
    render(<AIModelModeSwitch mode="select" onModeChange={vi.fn()} disabled />);

    expect(screen.getByRole("button", { name: "选择模型" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "手动输入" })).toBeDisabled();
  });

  it("renders one-line model options in select mode", async () => {
    const user = userEvent.setup();
    renderCombobox({ mode: "select" });

    await user.click(screen.getByRole("combobox", { name: "模型" }));
    const listbox = screen.getByRole("listbox");

    expect(within(listbox).getByText("GPT-5.4 Mini")).toBeInTheDocument();
    expect(within(listbox).queryByText("gpt-5.4-mini")).not.toBeInTheDocument();
    expect(within(listbox).queryByText("当前模型")).not.toBeInTheDocument();
    expect(within(listbox).queryByText("服务返回")).not.toBeInTheDocument();
    expect(within(listbox).queryByText("自定义输入")).not.toBeInTheDocument();
  });

  it("uses a neutral select trigger instead of a primary selected surface", () => {
    renderCombobox();

    const trigger = screen.getByRole("combobox", { name: "模型" });

    expect(trigger).toHaveClass("bg-secondary");
    expect(trigger).not.toHaveClass("bg-primary");
    expect(trigger).not.toHaveClass("text-primary");
    expect(trigger).not.toHaveClass("border-primary");
  });

  it("stretches the select trigger and popover to the form field width", async () => {
    const user = userEvent.setup();
    renderCombobox();

    const trigger = screen.getByRole("combobox", { name: "模型" });
    expect(trigger).toHaveClass("w-full");

    await user.click(trigger);
    expect(screen.getByTestId("ai-model-combobox-popover")).toHaveClass("w-(--radix-popover-trigger-width)");
  });

  it("locks page scrolling while the model list popover is open", async () => {
    const user = userEvent.setup();
    renderCombobox({ value: "gpt-5.4" });

    await user.click(screen.getByRole("combobox", { name: "模型" }));

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(document.body).toHaveAttribute("data-scroll-locked", "1");

    await user.keyboard("{Escape}");

    expect(document.body).not.toHaveAttribute("data-scroll-locked");
  });

  it("selects a returned model id from the list", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderCombobox({ value: "", onValueChange });

    await user.click(screen.getByRole("combobox", { name: "模型" }));
    const listbox = screen.getByRole("listbox");
    await user.click(within(listbox).getByText("GPT-5.4 Mini"));

    expect(onValueChange).toHaveBeenCalledWith("gpt-5.4-mini");
    expect(screen.getByRole("combobox", { name: "模型" })).toHaveTextContent("GPT-5.4 Mini");
  });

  it("marks the matched current model as selected without a current-model group", async () => {
    const user = userEvent.setup();
    renderCombobox();

    await user.click(screen.getByRole("combobox", { name: "模型" }));
    const currentOption = within(screen.getByRole("listbox")).getByText("GPT-5.5").closest("[cmdk-item]");

    expect(currentOption).toHaveAttribute("aria-current", "true");
    expect(screen.queryByText("当前模型")).not.toBeInTheDocument();
  });

  it("keeps select mode open when an automatic model request finishes with returned models", async () => {
    function RefreshingCombobox() {
      const [status, setStatus] = useState<"idle" | "loading" | "success">("idle");
      const [returnedModels, setReturnedModels] = useState<AiModelListItem[]>([]);
      return (
        <TooltipProvider delayDuration={0}>
          <AIModelCombobox
            id="ai-model"
            value=""
            onValueChange={vi.fn()}
            mode="select"
            models={returnedModels}
            status={status}
            error={null}
            truncated={false}
            canAutoRefreshModels
            onRequestModels={() => {
              setStatus("loading");
              setTimeout(() => {
                setReturnedModels(models);
                setStatus("success");
              }, 0);
            }}
            placeholder="输入模型"
          />
        </TooltipProvider>
      );
    }

    const user = userEvent.setup();
    render(<RefreshingCombobox />);

    await user.click(screen.getByRole("combobox", { name: "模型" }));

    expect(await screen.findByText("GPT-5.5")).toBeInTheDocument();
    expect(document.body).toHaveAttribute("data-scroll-locked", "1");
  });

  it("keeps compact empty, error and truncated states visible", async () => {
    const user = userEvent.setup();
    renderCombobox({
      mode: "select",
      value: "",
      models: [],
      status: "success",
      error: "无法获取模型列表",
      truncated: true,
    });

    await user.click(screen.getByRole("combobox", { name: "模型" }));

    expect(screen.getByText("没有可选择的模型。请确认 Base URL / API Key 已填写，或切换到手动输入。")).toBeInTheDocument();
    expect(screen.getByText("无法获取模型列表")).toBeInTheDocument();
    expect(screen.getByText("模型列表较长，仅显示前 300 个结果；可继续搜索或手动输入。")).toBeInTheDocument();
  });

  it("shows a compact loading state in select mode", async () => {
    const user = userEvent.setup();
    renderCombobox({ mode: "select", value: "", status: "loading" });

    await user.click(screen.getByRole("combobox", { name: "模型" }));

    expect(screen.getByText("正在获取模型列表...")).toBeInTheDocument();
  });
});
