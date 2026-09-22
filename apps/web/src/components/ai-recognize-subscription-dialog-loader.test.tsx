import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import { DEFAULT_SETTINGS } from "@/types/subscription";
import { DeferredAIRecognizeSubscriptionDialog } from "./ai-recognize-subscription-dialog-loader";

const moduleGate = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
});

vi.mock("@/components/ai-recognize-subscription-dialog", async () => {
  await moduleGate.promise;
  const dialog = await vi.importActual<typeof import("@/components/ui/dialog")>("@/components/ui/dialog");
  return {
    AIRecognizeSubscriptionDialogContent: () => (
      <>
        <dialog.DialogHeader>
          <dialog.DialogTitle>AI 识别账单</dialog.DialogTitle>
          <dialog.DialogDescription>AI 识别说明</dialog.DialogDescription>
        </dialog.DialogHeader>
        <div data-testid="ai-dialog-real-content">真实 AI 内容</div>
      </>
    ),
  };
});

vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => false }));
vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "common.close": "关闭",
      "common.loading": "加载中",
      "aiRecognition.dialogTitle": "AI 识别账单",
      "aiRecognition.dialogDescription": "AI 识别说明",
    }[key] ?? key),
  }),
}));

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>打开 AI</button>
      <DeferredAIRecognizeSubscriptionDialog
        open={open}
        onOpenChange={setOpen}
        settings={DEFAULT_SETTINGS}
        config={DEFAULT_CUSTOM_CONFIG}
      />
    </>
  );
}

describe("DeferredAIRecognizeSubscriptionDialog", () => {
  it("does not let a late AI module replace a closing dialog session", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.getByRole("dialog", { name: "AI 识别账单" })).toHaveAttribute("aria-busy", "true");
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await act(async () => {
      moduleGate.release();
      await moduleGate.promise;
    });
    expect(screen.queryByTestId("ai-dialog-real-content")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开 AI" }));
    expect(await screen.findByTestId("ai-dialog-real-content")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "AI 识别账单" })).not.toHaveAttribute("aria-busy");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
});
