import type { ReactNode } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import type { VirtualItem } from "@tanstack/react-virtual";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedImport } from "@/modules/import-export/domain/import-export-model";
import { makeDraft, makeResponse, renderDialog } from "./ai-recognize-subscription-dialog.test-utils";

const mocks = vi.hoisted(() => ({
  recognizeSubscriptionsStream: vi.fn(),
  previewPrepared: vi.fn(),
  resetImportPreview: vi.fn(),
}));

vi.mock("@/services/ai-recognition-service", () => ({
  aiRecognitionService: { recognizeSubscriptionsStream: mocks.recognizeSubscriptionsStream },
}));

vi.mock("@/modules/import-export/application/use-import-preview-apply", () => ({
  useImportPreviewApply: () => ({
    prepared: null,
    preview: null,
    conflictMode: "skip",
    previewFilter: "all",
    skippedIndexes: new Set<number>(),
    error: null,
    applying: false,
    assetProgress: null,
    applyProgress: null,
    setError: vi.fn(),
    setPreviewFilter: vi.fn(),
    resetImportPreview: mocks.resetImportPreview,
    previewPrepared: mocks.previewPrepared,
    handleConflictModeChange: vi.fn(),
    handleLogoChange: vi.fn(),
    handleSkipChange: vi.fn(),
    handleApply: vi.fn(),
  }),
}));

vi.mock("@/components/import-preview-panel", () => ({
  ImportPreviewPanel: () => <div data-testid="import-preview-panel" />,
}));

vi.mock("@/components/ui/virtualized-list", () => ({
  VirtualizedList: ({ count, renderItem }: {
    count: number;
    renderItem: (index: number, virtualItem: VirtualItem) => ReactNode;
  }) => (
    <div>
      {Array.from({ length: count }, (_, index) => (
        <div key={index}>
          {renderItem(index, { index, key: index, start: 0, size: 112, end: 112, lane: 0 })}
        </div>
      ))}
    </div>
  ),
}));

describe("AIRecognizeSubscriptionDialog family sharing", () => {
  beforeEach(() => {
    mocks.recognizeSubscriptionsStream.mockReset();
    mocks.previewPrepared.mockReset();
    mocks.resetImportPreview.mockReset();
  });

  it("在 AI 草稿中完整管理家庭成员并保留全部可见字段到预览", async () => {
    const user = userEvent.setup();
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([
      makeDraft({
        name: "Family Plan",
        price: "60",
        currency: "USD",
        billingCycle: "monthly",
        startDate: "2026-06-01",
        nextBillingDate: "2026-07-01",
        autoCalculateNextBillingDate: false,
      }),
      makeDraft({ name: "Other Plan" }),
    ]));
    const { onOpenChange } = renderDialog();

    await user.type(screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表..."), "family 60\nother 50");
    await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));
    await screen.findByDisplayValue("Family Plan");
    await user.click(screen.getByRole("switch", { name: "自动续订" }));
    await user.click(screen.getByRole("switch", { name: "从公开页隐藏" }));
    await user.click(screen.getByRole("switch", { name: "家庭共享" }));

    const manageMembersButton = screen.getByRole("button", { name: "管理成员" });
    await user.click(manageMembersButton);
    const memberDialog = screen.getByRole("dialog", { name: "管理共享成员" });
    expect(within(memberDialog).getByLabelText("成员名称")).toHaveFocus();
    await user.click(within(memberDialog).getByRole("button", { name: "添加成员" }));
    const memberNames = within(memberDialog).getAllByLabelText("成员名称");
    await user.clear(memberNames[0]!);
    await user.type(memberNames[0]!, "家人");
    await user.clear(memberNames[1]!);
    await user.type(memberNames[1]!, "朋友");
    await user.click(within(memberDialog).getAllByRole("button", { name: "删除" })[0]!);
    expect(within(memberDialog).getByLabelText("成员名称")).toHaveValue("朋友");
    await user.click(within(memberDialog).getByRole("switch", { name: "收款提醒" }));
    await user.click(within(memberDialog).getByRole("button", { name: /上车日期/ }));
    await user.click(await screen.findByRole("button", { name: /2026年6月15日/ }));
    await user.click(within(memberDialog).getByRole("button", { name: "完成" }));

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(manageMembersButton).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "AI 识别订阅" })).toBeInTheDocument();
    await user.click(screen.getByText("Other Plan", { selector: "span" }));
    await screen.findByDisplayValue("Other Plan");
    await user.click(screen.getByText("Family Plan", { selector: "span" }));
    await screen.findByDisplayValue("Family Plan");
    expect(screen.getByRole("switch", { name: "自动续订" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "从公开页隐藏" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "家庭共享" })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "管理成员" }));
    const reopenedMemberDialog = screen.getByRole("dialog", { name: "管理共享成员" });
    expect(within(reopenedMemberDialog).getByLabelText("成员名称")).toHaveValue("朋友");
    expect(within(reopenedMemberDialog).getByRole("switch", { name: "收款提醒" })).toBeChecked();
    expect(within(reopenedMemberDialog).getByRole("button", { name: /上车日期/ })).toHaveTextContent("2026年6月15日");
    await user.click(within(reopenedMemberDialog).getByRole("button", { name: "完成" }));
    await user.click(screen.getByRole("button", { name: "生成导入预览" }));

    await waitFor(() => expect(mocks.previewPrepared).toHaveBeenCalledTimes(1));
    const prepared = mocks.previewPrepared.mock.calls[0]?.[0] as PreparedImport;
    expect(prepared.payload.subscriptions[0]).toMatchObject({
      name: "Family Plan",
      autoRenew: true,
      publicHidden: true,
      costSharing: {
        enabled: true,
        splitMode: "equal",
        collectionReminder: { enabled: true, reminderDays: -1 },
        members: [{ name: "朋友", joinedDate: "2026-06-15" }],
      },
    });
  });
});
