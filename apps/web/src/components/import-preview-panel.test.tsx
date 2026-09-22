import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImportPreviewPanel } from "./import-preview-panel";
import type { ImportPayload, ImportPreviewResponse } from "@/lib/api/schemas/import-export";
import type { PreparedImport } from "@/modules/import-export/domain/import-export-model";

vi.mock("@/components/import-preview-list", () => ({
  ImportPreviewList: () => <div data-testid="import-preview-list" />,
}));

const payload = {
  source: "renewlet",
  subscriptions: [
    {
      name: "Sentry Business",
      logo: null,
      price: "29",
      currency: "USD",
      category: "developer_tools",
      status: "active",
      pinned: false,
      publicHidden: false,
      paymentMethod: undefined,
      startDate: "2026-05-01",
      nextBillingDate: "2026-06-01",
      autoRenew: false,
      autoCalculateNextBillingDate: true,
      trialEndDate: undefined,
      billingCycle: "monthly",
      customDays: undefined,
      customCycleUnit: undefined,
      reminderDays: 5,
      website: undefined,
      notes: undefined,
      tags: [],
      repeatReminderEnabled: false,
      repeatReminderInterval: "24h",
      repeatReminderWindow: "24h",
      extra: {
        import: {
          source: "renewlet",
          sourceId: "sentry",
          confidence: "high",
        },
      },
    },
  ],
} satisfies ImportPayload;

const prepared = {
  payload,
  assets: [],
  warnings: [],
} satisfies PreparedImport;

const preview = {
  summary: {
    total: 1,
    creates: 1,
    replaces: 0,
    skips: 0,
    errors: 0,
    warnings: 0,
  },
  items: [
    {
      index: 0,
      name: "Sentry Business",
      source: "renewlet",
      sourceId: "sentry",
      action: "create",
      warnings: [],
      errors: [],
    },
  ],
  includesSettings: false,
  includesCustomConfig: false,
  includesExchangeRateSnapshots: false,
  exchangeRateSnapshotsCount: 0,
} satisfies ImportPreviewResponse;

function renderPanel(showImportOptions?: boolean) {
  render(
    <ImportPreviewPanel
      prepared={prepared}
      preview={preview}
      conflictMode="skip"
      previewFilter="all"
      skippedIndexes={new Set<number>()}
      {...(showImportOptions === undefined ? {} : { showImportOptions })}
      onConflictModeChange={vi.fn()}
      onPreviewFilterChange={vi.fn()}
      onLogoChange={vi.fn()}
      onSkipChange={vi.fn()}
    />,
  );
}

describe("ImportPreviewPanel", () => {
  it("默认保留普通导入的导入设置控件", () => {
    renderPanel();

    expect(screen.getByText("导入设置")).toBeInTheDocument();
    const conflictMode = screen.getByRole("combobox", { name: "冲突处理" });
    expect(conflictMode.closest('[data-slot="form-field-row"]')).toHaveAttribute("data-align-at", "md");
    expect(screen.getByTestId("import-preview-list")).toBeInTheDocument();
  });

  it("让 Wallos 用户和冲突策略共享公共字段轨道", () => {
    render(
      <ImportPreviewPanel
        prepared={{ ...prepared, payload: { ...payload, source: "wallos" } }}
        preview={preview}
        conflictMode="skip"
        previewFilter="all"
        skippedIndexes={new Set<number>()}
        wallosUsers={[
          { id: "user-1", label: "Alice" },
          { id: "user-2", label: "Bob" },
        ]}
        selectedWallosUser="user-1"
        onConflictModeChange={vi.fn()}
        onWallosUserChange={vi.fn()}
        onPreviewFilterChange={vi.fn()}
        onLogoChange={vi.fn()}
        onSkipChange={vi.fn()}
      />,
    );

    const wallosUser = screen.getByRole("combobox", { name: "Wallos 用户" });
    const row = wallosUser.closest('[data-slot="form-field-row"]');
    expect(row).toHaveAttribute("data-tracks", "2");
    expect(row?.querySelectorAll('[data-slot="form-field"]')).toHaveLength(2);
    expect(screen.getByRole("combobox", { name: "冲突处理" }).closest('[data-slot="form-field-row"]')).toBe(row);
  });

  it("在 Wallos 用户选择状态完整后才渲染对应字段", () => {
    render(
      <ImportPreviewPanel
        prepared={{ ...prepared, payload: { ...payload, source: "wallos" } }}
        preview={preview}
        conflictMode="skip"
        previewFilter="all"
        skippedIndexes={new Set<number>()}
        wallosUsers={[
          { id: "user-1", label: "Alice" },
          { id: "user-2", label: "Bob" },
        ]}
        selectedWallosUser=""
        onConflictModeChange={vi.fn()}
        onWallosUserChange={vi.fn()}
        onPreviewFilterChange={vi.fn()}
        onLogoChange={vi.fn()}
        onSkipChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("combobox", { name: "Wallos 用户" })).not.toBeInTheDocument();
    const conflictMode = screen.getByRole("combobox", { name: "冲突处理" });
    expect(conflictMode.closest('[data-slot="form-field-row"]')?.querySelectorAll('[data-slot="form-field"]')).toHaveLength(1);
  });

  it("允许 AI 识别预览隐藏导入设置控件但保留预览内容", () => {
    renderPanel(false);

    expect(screen.queryByText("导入设置")).not.toBeInTheDocument();
    expect(screen.queryByText("冲突处理")).not.toBeInTheDocument();
    expect(screen.getByText("预览结果")).toBeInTheDocument();
    expect(screen.getByTestId("import-preview-list")).toBeInTheDocument();
  });
});
