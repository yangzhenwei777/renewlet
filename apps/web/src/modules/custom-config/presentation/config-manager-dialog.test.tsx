// 配置管理弹窗测试保护排序、启用、只读和上传中禁保存，避免自定义配置 UI 绕过 domain 策略。
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfigManagerDialog } from "./config-manager-dialog";
import type { ConfigItem } from "@/types/config";

const statusItems: ConfigItem[] = [
  { id: "trial", value: "trial", labels: { "zh-CN": "试用中", "en-US": "Trial" }, color: "#fbbf24" },
  { id: "active", value: "active", labels: { "zh-CN": "活跃", "en-US": "Active" }, color: "#22c55e" },
  { id: "expired", value: "expired", labels: { "zh-CN": "已过期", "en-US": "Expired" }, color: "#ef4444" },
  { id: "paused", value: "paused", labels: { "zh-CN": "已暂停", "en-US": "Paused" }, color: "#f59e0b" },
  { id: "cancelled", value: "cancelled", labels: { "zh-CN": "已取消", "en-US": "Cancelled" }, color: "#ef4444" },
];

const dialogCases: Array<{
  title: string;
  items: ConfigItem[];
  props?: Partial<ComponentProps<typeof ConfigManagerDialog>>;
  expectedValues: string[];
}> = [
  {
    title: "分类管理",
    items: [
      { id: "work", value: "work", labels: { "zh-CN": "工作", "en-US": "Work" }, color: "#22c55e" },
      { id: "life", value: "life", labels: { "zh-CN": "生活", "en-US": "Life" }, color: "#3b82f6" },
    ],
    props: { showColor: true },
    expectedValues: ["work", "life"],
  },
  {
    title: "状态管理",
    items: statusItems,
    props: { showColor: true, readOnly: true },
    expectedValues: ["trial", "active", "expired", "paused", "cancelled"],
  },
  {
    title: "支付方式管理",
    items: [
      { id: "alipay", value: "alipay", labels: { "zh-CN": "支付宝", "en-US": "Alipay" } },
      { id: "stripe", value: "stripe", labels: { "zh-CN": "Stripe", "en-US": "Stripe" } },
    ],
    props: { showIcon: true },
    expectedValues: ["alipay", "stripe"],
  },
  {
    title: "货币管理",
    items: [
      { id: "CNY", value: "CNY", labels: { "zh-CN": "人民币", "en-US": "Chinese yuan" }, enabled: true },
      { id: "USD", value: "USD", labels: { "zh-CN": "美元", "en-US": "US dollar" }, enabled: true },
    ],
    props: { toggleMode: true },
    expectedValues: ["CNY", "USD"],
  },
];

function getTopDialogOverlay() {
  const overlays = document.querySelectorAll<HTMLElement>("[data-dialog-overlay]");
  const overlay = overlays.item(overlays.length - 1);
  if (!overlay) throw new Error("Dialog overlay was not rendered");
  return overlay;
}

describe("ConfigManagerDialog", () => {
  it.each(dialogCases)("renders $title items immediately after opening", async ({ title, items, props, expectedValues }) => {
    const user = userEvent.setup();

    render(
      <TooltipProvider delayDuration={0}>
        <ConfigManagerDialog
          title={title}
          items={items}
          onUpdate={vi.fn()}
          {...props}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: new RegExp(title) }));

    const dialog = screen.getByRole("dialog", { name: title });
    expect(dialog).toHaveAccessibleDescription(new RegExp(`管理${title}`));
    for (const value of expectedValues) {
      expect(within(dialog).getByText(value)).toBeInTheDocument();
    }
    expect(dialog.querySelector('[class~="min-h-60"]')).toBeNull();
  });

  it("uses the visible description as the dialog accessible description", async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider delayDuration={0}>
        <ConfigManagerDialog
          title="分类管理"
          description="自定义订阅分类的名称、颜色和排序。"
          items={dialogCases[0]?.items ?? []}
          onUpdate={vi.fn()}
          showColor
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: /分类管理/ }));

    const dialog = screen.getByRole("dialog", { name: "分类管理" });
    expect(dialog).toHaveAccessibleDescription("自定义订阅分类的名称、颜色和排序。");
    expect(within(dialog).getByText("自定义订阅分类的名称、颜色和排序。")).toBeInTheDocument();
  });

  it("requires explicit close controls for config management dialogs", async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider delayDuration={0}>
        <ConfigManagerDialog
          title="分类管理"
          description="自定义订阅分类的名称、颜色和排序。"
          items={dialogCases[0]?.items ?? []}
          onUpdate={vi.fn()}
          showColor
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: /分类管理/ }));
    expect(screen.getByRole("dialog", { name: "分类管理" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "分类管理" })).toBeInTheDocument();

    await user.click(getTopDialogOverlay());
    expect(screen.getByRole("dialog", { name: "分类管理" })).toBeInTheDocument();

    fireEvent.focusIn(document.body);
    const dialog = screen.getByRole("dialog", { name: "分类管理" });
    const closeButton = dialog.querySelector<HTMLButtonElement>("[data-dialog-close]");
    expect(closeButton).toHaveAccessibleName("关闭");
    if (!closeButton) throw new Error("Expected the dialog close button");

    await user.click(closeButton);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "分类管理" })).not.toBeInTheDocument();
    });
  });

  it("filters currency options by code, localized label, and symbol", async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider delayDuration={0}>
        <ConfigManagerDialog
          title="货币管理"
          items={[
            { id: "CNY", value: "CNY", labels: { "zh-CN": "¥ 人民币 (CNY)", "en-US": "¥ Chinese Yuan (CNY)" }, enabled: true },
            { id: "USD", value: "USD", labels: { "zh-CN": "$ 美元 (USD)", "en-US": "$ US Dollar (USD)" }, enabled: true },
            { id: "EUR", value: "EUR", labels: { "zh-CN": "€ 欧元 (EUR)", "en-US": "€ Euro (EUR)" }, enabled: true },
          ]}
          onUpdate={vi.fn()}
          toggleMode
          searchable
          searchPlaceholder="搜索货币、代码或符号..."
          searchEmptyMessage="未找到货币"
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: /货币管理/ }));
    const dialog = screen.getByRole("dialog", { name: "货币管理" });
    const search = within(dialog).getByPlaceholderText("搜索货币、代码或符号...");

    await user.type(search, "eur");
    expect(within(dialog).getByText("EUR")).toBeInTheDocument();
    expect(within(dialog).queryByText("CNY")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "人民币");
    expect(within(dialog).getByText("CNY")).toBeInTheDocument();
    expect(within(dialog).queryByText("EUR")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "$");
    expect(within(dialog).getByText("USD")).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "zzzz");
    expect(within(dialog).getByText("未找到货币")).toBeInTheDocument();
  });

  it("filters short currency code queries without unrelated subsequence matches", async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider delayDuration={0}>
        <ConfigManagerDialog
          title="货币管理"
          items={[
            { id: "HKD", value: "HKD", labels: { "zh-CN": "HK$ 港元 (HKD)", "en-US": "HK$ Hong Kong Dollar (HKD)" }, enabled: true },
            { id: "AFN", value: "AFN", labels: { "zh-CN": "AFN 阿富汗尼", "en-US": "AFN Afghan Afghani" }, enabled: true },
            { id: "NGN", value: "NGN", labels: { "zh-CN": "₦ 尼日利亚奈拉 (NGN)", "en-US": "₦ Nigerian Naira (NGN)" }, enabled: true },
            { id: "NIO", value: "NIO", labels: { "zh-CN": "NIO 尼加拉瓜科多巴", "en-US": "NIO Nicaraguan Córdoba" }, enabled: true },
          ]}
          onUpdate={vi.fn()}
          toggleMode
          searchable
          searchPlaceholder="搜索货币、代码或符号..."
          searchEmptyMessage="未找到货币"
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: /货币管理/ }));
    const dialog = screen.getByRole("dialog", { name: "货币管理" });
    const search = within(dialog).getByPlaceholderText("搜索货币、代码或符号...");

    await user.type(search, "ngn");
    expect(within(dialog).getByText("NGN")).toBeInTheDocument();
    expect(within(dialog).queryByText("HKD")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("AFN")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("NIO")).not.toBeInTheDocument();

    await user.clear(search);
    expect(within(dialog).getByText("HKD")).toBeInTheDocument();
    expect(within(dialog).getByText("AFN")).toBeInTheDocument();
    expect(within(dialog).getByText("NIO")).toBeInTheDocument();
  });

  it("keeps searchable config dialogs in a bounded scroll structure", async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider delayDuration={0}>
        <ConfigManagerDialog
          title="货币管理"
          items={Array.from({ length: 12 }, (_, index) => ({
            id: `C${index}`,
            value: `C${index}`,
            labels: { "zh-CN": `测试货币 ${index}`, "en-US": `Test currency ${index}` },
            enabled: true,
          }))}
          onUpdate={vi.fn()}
          toggleMode
          searchable
          searchPlaceholder="搜索货币、代码或符号..."
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: /货币管理/ }));
    const dialog = screen.getByRole("dialog", { name: "货币管理" });
    const header = dialog.querySelector("[data-settings-manager-header]");
    const controls = dialog.querySelector("[data-config-manager-controls]");
    const scrollRegion = dialog.querySelector("[data-config-manager-scroll]");
    const list = dialog.querySelector("[data-config-manager-list]");
    const footer = dialog.querySelector("[data-settings-manager-footer]");

    expect(dialog).toHaveClass(
      "h5-dialog-frame",
      "h5-settings-manager-dialog-panel",
      "max-w-3xl",
      "overflow-hidden",
      "p-0",
    );
    expect(header).toHaveClass("shrink-0");
    expect(controls).toHaveClass("shrink-0");
    expect(scrollRegion).toHaveClass("min-h-0", "overflow-y-auto");
    expect(scrollRegion).not.toHaveClass("grid");
    expect(scrollRegion).not.toHaveClass("flex");
    expect(list).toHaveClass("flex", "flex-col", "gap-2");
    expect(footer).toHaveClass("shrink-0");
  });

  it("keeps filtered currency rows at their content height", async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider delayDuration={0}>
        <ConfigManagerDialog
          title="货币管理"
          items={[
            { id: "BRL", value: "BRL", labels: { "zh-CN": "R$ 巴西雷亚尔 (BRL)", "en-US": "R$ Brazilian Real (BRL)" }, enabled: true },
            { id: "ERN", value: "ERN", labels: { "zh-CN": "ERN 厄立特里亚纳克法", "en-US": "ERN Eritrean Nakfa" }, enabled: true },
            { id: "KRW", value: "KRW", labels: { "zh-CN": "₩ 韩元 (KRW)", "en-US": "₩ South Korean Won (KRW)" }, enabled: true },
            { id: "SGD", value: "SGD", labels: { "zh-CN": "SGD 新加坡元", "en-US": "SGD Singapore Dollar" }, enabled: true },
          ]}
          onUpdate={vi.fn()}
          toggleMode
          searchable
          searchPlaceholder="搜索货币、代码或符号..."
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: /货币管理/ }));
    const dialog = screen.getByRole("dialog", { name: "货币管理" });
    const search = within(dialog).getByPlaceholderText("搜索货币、代码或符号...");

    await user.type(search, "re");

    const list = dialog.querySelector("[data-config-manager-list]");
    const rows = Array.from(dialog.querySelectorAll("[data-config-manager-item]"));
    expect(list).toHaveClass("flex", "flex-col", "gap-2");
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.parentElement === list)).toBe(true);
    for (const row of rows) {
      expect(row).toHaveClass("shrink-0");
    }
  });

  it("keeps disabled currency rows readable and lets the switch show the off state", async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider delayDuration={0}>
        <ConfigManagerDialog
          title="货币管理"
          items={[
            { id: "CNY", value: "CNY", labels: { "zh-CN": "¥ 人民币 (CNY)", "en-US": "¥ Chinese Yuan (CNY)" }, enabled: true },
            { id: "USD", value: "USD", labels: { "zh-CN": "$ 美元 (USD)", "en-US": "$ US Dollar (USD)" }, enabled: false },
          ]}
          onUpdate={vi.fn()}
          toggleMode
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: /货币管理/ }));
    const dialog = screen.getByRole("dialog", { name: "货币管理" });
    const usdRow = within(dialog).getByText("USD").closest("[data-config-manager-item]");
    if (!(usdRow instanceof HTMLElement)) throw new Error("USD row should be rendered");
    expect(usdRow).not.toHaveClass("opacity-50");
    expect(within(usdRow).getByText("$ 美元 (USD)")).not.toHaveClass("text-muted-foreground");
    expect(within(usdRow).getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("names row actions by object and restores focus after confirming deletion", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(
      <TooltipProvider delayDuration={0}>
        <ConfigManagerDialog title="分类管理" items={dialogCases[0]?.items ?? []} onUpdate={onUpdate} showColor />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: /分类管理/ }));
    const dialog = screen.getByRole("dialog", { name: "分类管理" });
    expect(within(dialog).getByRole("button", { name: "拖动「工作」排序" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "编辑「工作」" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "删除「工作」" }));

    const confirmation = screen.getByRole("alertdialog", { name: "删除「工作」？" });
    expect(within(confirmation).getByText("已有订阅数据会保留；该选项将不再可选，并可能影响展示或筛选。")).toBeInTheDocument();
    await user.click(within(confirmation).getByRole("button", { name: /删除/ }));

    expect(onUpdate).toHaveBeenCalled();
    const footerButton = dialog.querySelector<HTMLButtonElement>("[data-settings-manager-footer] button");
    expect(footerButton).toHaveFocus();
  });
});
