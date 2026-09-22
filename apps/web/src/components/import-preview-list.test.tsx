// 导入预览列表测试保护冲突预览里的真实订阅 Logo 展示，避免它和卡片/日历入口再次分叉。
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImportPreviewList } from "./import-preview-list";
import type { ImportPayload, ImportPreviewResponse } from "@/lib/api/schemas/import-export";
import type { PreparedImport } from "@/modules/import-export/domain/import-export-model";

vi.mock("@/components/import-logo-editor", () => ({
  ImportLogoEditor: ({ name, website }: { name: string; website?: string | null }) => (
    <button type="button" data-website={website ?? ""}>修改 {name} Logo</button>
  ),
}));

const payload = {
  source: "renewlet",
  subscriptions: [
    {
      name: "ngrok",
      logo: "https://example.com/ngrok.svg",
      price: "12",
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
          sourceId: "ngrok",
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
      name: "ngrok",
      source: "renewlet",
      sourceId: "ngrok",
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

describe("ImportPreviewList", () => {
  it("renders preview row logos on the unified subscription logo surface", () => {
    render(
      <ImportPreviewList
        prepared={prepared}
        preview={preview}
        filter="all"
        skippedIndexes={new Set<number>()}
        onFilterChange={vi.fn()}
        onLogoChange={vi.fn()}
        onSkipChange={vi.fn()}
      />,
    );

    const logo = screen.getByAltText("ngrok");
    const logoTile = logo.closest(".subscription-logo-tile");
    if (!logoTile) throw new Error("Expected preview logo to use the subscription logo tile.");

    expect(logo).toHaveClass("subscription-logo-image", "object-contain");
    expect(logo).not.toHaveClass("media-thumbnail-image", "invert", "brightness-125", "mix-blend-screen");
    expect(logoTile).not.toHaveClass("media-thumbnail-canvas");
    expect(logoTile).not.toHaveClass("bg-linear-to-br");
  });

  it("passes the imported website to each row Logo editor", () => {
    const preparedWithWebsite = {
      ...prepared,
      payload: {
        ...payload,
        subscriptions: [{ ...payload.subscriptions[0]!, website: "https://ngrok.com/" }],
      },
    } satisfies PreparedImport;

    render(
      <ImportPreviewList
        prepared={preparedWithWebsite}
        preview={preview}
        filter="all"
        skippedIndexes={new Set<number>()}
        onFilterChange={vi.fn()}
        onLogoChange={vi.fn()}
        onSkipChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "修改 ngrok Logo" })).toHaveAttribute("data-website", "https://ngrok.com/");
  });
});
