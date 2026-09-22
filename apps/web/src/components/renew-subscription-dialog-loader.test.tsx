import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import { DeferredRenewSubscriptionDialog } from "./renew-subscription-dialog-loader";

const moduleGate = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
});

vi.mock("@/components/renew-subscription-dialog", async () => {
  await moduleGate.promise;
  const dialog = await vi.importActual<typeof import("@/components/ui/dialog")>("@/components/ui/dialog");
  return {
    RenewSubscriptionDialogContent: () => (
      <>
        <dialog.DialogHeader>
          <dialog.DialogTitle>续订</dialog.DialogTitle>
          <dialog.DialogDescription>续订说明</dialog.DialogDescription>
        </dialog.DialogHeader>
        <div data-testid="renew-dialog-real-content">真实续订内容</div>
      </>
    ),
  };
});

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "common.close": "关闭",
      "common.loading": "加载中",
      "subscription.renew": "续订",
      "subscription.renew.description": "续订说明",
    }[key] ?? key),
  }),
}));

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>打开续订</button>
      <DeferredRenewSubscriptionDialog
        subscription={null}
        loadingPreview={null}
        open={open}
        today={assertDateOnly("2026-08-19")}
        submitting={false}
        onOpenChange={setOpen}
        onSubmit={vi.fn()}
      />
    </>
  );
}

describe("DeferredRenewSubscriptionDialog", () => {
  it("does not replace closing module pending with late content and reuses the cached module next time", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByTestId("renew-subscription-dialog-module-pending")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await act(async () => {
      moduleGate.release();
      await moduleGate.promise;
    });
    expect(screen.queryByTestId("renew-dialog-real-content")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开续订" }));
    expect(await screen.findByTestId("renew-dialog-real-content")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "续订" })).not.toHaveAttribute("aria-busy");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByTestId("renew-subscription-dialog-module-pending")).not.toBeInTheDocument();
  });
});
