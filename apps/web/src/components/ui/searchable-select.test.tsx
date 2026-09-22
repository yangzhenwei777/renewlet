// SearchableSelect 测试保护货币/配置下拉的搜索、禁用项和移动端 sheet 行为。
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockMobileOverlayMatch, resetMobileOverlayTestEnvironment } from "@/components/ui/mobile-overlay.test-utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SearchableSelect, type SearchableSelectOption } from "./searchable-select";

const options: SearchableSelectOption[] = [
  { value: "CNY", label: "¥ 人民币 (CNY)", keywords: ["人民币", "china", "yuan"] },
  { value: "USD", label: "$ 美元 (USD)", keywords: ["美元", "$", "US Dollar"] },
  { value: "EUR", label: "€ 欧元 (EUR)", keywords: ["欧元", "Euro"], disabled: true },
];

function renderWithTooltipProvider(ui: ReactNode) {
  return render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

function setElementOverflow(element: Element) {
  Object.defineProperties(element, {
    scrollWidth: { configurable: true, value: 320 },
    clientWidth: { configurable: true, value: 120 },
    scrollHeight: { configurable: true, value: 20 },
    clientHeight: { configurable: true, value: 20 },
  });
  fireEvent.resize(window);
}

describe("SearchableSelect", () => {
  afterEach(() => {
    resetMobileOverlayTestEnvironment();
  });

  it("filters options and selects a matching item", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    renderWithTooltipProvider(
      <SearchableSelect
        value="CNY"
        onValueChange={onValueChange}
        options={options}
        searchPlaceholder="搜索货币"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("搜索货币"), "usd");
    await user.click(await screen.findByText("$ 美元 (USD)"));

    expect(onValueChange).toHaveBeenCalledWith("USD");
  });

  it("renders the shared mobile sheet chrome for searchable overlays", async () => {
    mockMobileOverlayMatch();
    const user = userEvent.setup();

    renderWithTooltipProvider(
      <SearchableSelect
        value="CNY"
        onValueChange={vi.fn()}
        options={options}
        searchPlaceholder="搜索货币"
        aria-label="选择货币"
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "选择货币" }));

    const sheet = screen.getByTestId("searchable-select-sheet");
    expect(sheet).toHaveAttribute("data-vaul-drawer");
    expect(sheet).toHaveClass("h5-mobile-sheet-content");
    expect(sheet).toHaveAttribute("data-mobile-detent", "large");
    expect(sheet).toHaveAttribute("aria-label", "选择货币");
    expect(sheet.querySelector("[data-vaul-handle]")).not.toBeNull();
    expect(screen.getByText("选择货币")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });

  it("filters short currency code queries without loose subsequence matches", async () => {
    const user = userEvent.setup();
    const currencyOptions: SearchableSelectOption[] = [
      { value: "HKD", label: "HK$ 港元 (HKD)", keywords: ["Hong Kong dollar"] },
      { value: "AFN", label: "AFN 阿富汗尼", keywords: ["Afghan Afghani"] },
      { value: "NGN", label: "₦ 尼日利亚奈拉 (NGN)", keywords: ["Nigerian Naira"] },
      { value: "NIO", label: "NIO 尼加拉瓜科多巴", keywords: ["Nicaraguan Córdoba"] },
    ];

    renderWithTooltipProvider(
      <SearchableSelect
        value=""
        onValueChange={vi.fn()}
        options={currencyOptions}
        searchPlaceholder="搜索货币"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("搜索货币"), "ngn");

    const listbox = screen.getByRole("listbox");
    expect(await within(listbox).findByText("₦ 尼日利亚奈拉 (NGN)")).toBeInTheDocument();
    await waitFor(() => {
      expect(within(listbox).queryByText("HK$ 港元 (HKD)")).not.toBeInTheDocument();
      expect(within(listbox).queryByText("AFN 阿富汗尼")).not.toBeInTheDocument();
      expect(within(listbox).queryByText("NIO 尼加拉瓜科多巴")).not.toBeInTheDocument();
    });
  });

  it("keeps filtered results in caller order instead of ranking exact matches first", async () => {
    const user = userEvent.setup();
    const currencyOptions: SearchableSelectOption[] = [
      { value: "CNY", label: "¥ 人民币 (CNY) with USD reference", keywords: ["reference usd"] },
      { value: "USD", label: "$ 美元 (USD)", keywords: ["美元", "US Dollar"] },
      { value: "EUR", label: "€ 欧元 (EUR)", keywords: ["Euro"] },
    ];

    renderWithTooltipProvider(
      <SearchableSelect
        value=""
        onValueChange={vi.fn()}
        options={currencyOptions}
        searchPlaceholder="搜索货币"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("搜索货币"), "usd");

    const listbox = screen.getByRole("listbox");
    await within(listbox).findByText("$ 美元 (USD)");
    const renderedLabels = Array.from(listbox.querySelectorAll<HTMLElement>("[cmdk-item]"))
      .map((item) => item.textContent);
    expect(renderedLabels).toEqual([
      "¥ 人民币 (CNY) with USD reference",
      "$ 美元 (USD)",
    ]);
  });

  it("filters single-character currency searches without generic substring noise", async () => {
    const user = userEvent.setup();
    const currencyOptions: SearchableSelectOption[] = [
      { value: "GBP", label: "£ 英镑 (GBP)", keywords: ["pound sterling", "global", "currency"] },
      { value: "AUD", label: "AU$ 澳大利亚元 (AUD)", keywords: ["Australian dollar"] },
      { value: "USD", label: "$ 美元 (USD)", keywords: ["美元", "US Dollar"] },
      { value: "TRY", label: "₺ 土耳其里拉 (TRY)", keywords: ["Turkish lira"] },
      { value: "UGX", label: "UGX 乌干达先令", keywords: ["Ugandan Shilling"] },
      { value: "PHP", label: "₱ 菲律宾比索 (PHP)", keywords: ["Philippine peso", "currency"] },
    ];

    renderWithTooltipProvider(
      <SearchableSelect
        value=""
        onValueChange={vi.fn()}
        options={currencyOptions}
        searchPlaceholder="搜索货币"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("搜索货币"), "u");

    const listbox = screen.getByRole("listbox");
    await within(listbox).findByText("$ 美元 (USD)");
    const renderedLabels = Array.from(listbox.querySelectorAll<HTMLElement>("[cmdk-item]"))
      .map((item) => item.textContent);
    expect(renderedLabels).toEqual([
      "$ 美元 (USD)",
      "UGX 乌干达先令",
    ]);
  });

  it("does not select disabled items", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    renderWithTooltipProvider(
      <SearchableSelect
        value="CNY"
        onValueChange={onValueChange}
        options={options}
        searchPlaceholder="搜索货币"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("搜索货币"), "euro");
    fireEvent.click(await screen.findByText("€ 欧元 (EUR)"));

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("does not mark explicitly enabled options as disabled", async () => {
    const user = userEvent.setup();

    renderWithTooltipProvider(
      <SearchableSelect
        value="CNY"
        onValueChange={vi.fn()}
        options={[
          { value: "CNY", label: "¥ 人民币 (CNY)", disabled: false },
          { value: "USD", label: "$ 美元 (USD)", disabled: true },
        ]}
        searchPlaceholder="搜索货币"
      />,
    );

    await user.click(screen.getByRole("combobox"));

    const listbox = screen.getByRole("listbox");
    expect(within(listbox).getByText("¥ 人民币 (CNY)").closest("[cmdk-item]")).toHaveAttribute("data-disabled", "false");
    expect(within(listbox).getByText("$ 美元 (USD)").closest("[cmdk-item]")).toHaveAttribute("data-disabled", "true");
  });

  it("shows empty state when no option matches", async () => {
    const user = userEvent.setup();

    renderWithTooltipProvider(
      <SearchableSelect
        value="CNY"
        onValueChange={vi.fn()}
        options={options}
        searchPlaceholder="搜索货币"
        emptyMessage="未找到货币"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("搜索货币"), "zzzz");

    await waitFor(() => expect(screen.getByText("未找到货币")).toBeVisible());
  });

  it("limits the initial list but still searches all options", async () => {
    const user = userEvent.setup();
    const manyOptions = Array.from({ length: 150 }, (_, index) => ({
      value: `item-${index}`,
      label: `选项 ${index}`,
    }));

    renderWithTooltipProvider(
      <SearchableSelect
        value="item-0"
        onValueChange={vi.fn()}
        options={manyOptions}
        searchPlaceholder="搜索选项"
        initialRenderLimit={10}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    expect(screen.getByText("选项 9")).toBeInTheDocument();
    expect(screen.queryByText("选项 149")).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("搜索选项"), "149");

    expect(await screen.findByText("选项 149")).toBeInTheDocument();
  });

  it("keeps the selected option visible when it is outside the initial limit", async () => {
    const user = userEvent.setup();
    const manyOptions = Array.from({ length: 15 }, (_, index) => ({
      value: `item-${index}`,
      label: `选项 ${index}`,
    }));

    renderWithTooltipProvider(
      <SearchableSelect
        value="item-12"
        onValueChange={vi.fn()}
        options={manyOptions}
        searchPlaceholder="搜索选项"
        initialRenderLimit={10}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    const listbox = screen.getByRole("listbox");
    const renderedLabels = Array.from(listbox.querySelectorAll<HTMLElement>("[cmdk-item]"))
      .map((item) => item.textContent);
    expect(renderedLabels).toEqual([
      "选项 0",
      "选项 1",
      "选项 2",
      "选项 3",
      "选项 4",
      "选项 5",
      "选项 6",
      "选项 7",
      "选项 8",
      "选项 9",
      "选项 10",
      "选项 11",
      "选项 12",
    ]);
    expect(within(listbox).queryByText("选项 13")).not.toBeInTheDocument();
  });

  it("shows a tooltip for a truncated selected option", async () => {
    const user = userEvent.setup();
    const longLabel = "超级长的统计货币名称和代码展示内容";

    renderWithTooltipProvider(
      <SearchableSelect
        value="LONG"
        onValueChange={vi.fn()}
        options={[{ value: "LONG", label: longLabel }]}
        aria-label="选择长选项"
      />,
    );

    setElementOverflow(screen.getByText(longLabel));
    await user.hover(screen.getByText(longLabel));

    expect(await screen.findByRole("tooltip")).toHaveTextContent(longLabel);
  });
});
