// 冷模块只替换同步 shell 内的内容；Portal、焦点域和 open session 在加载完成前后必须保持同一所有者。
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SubscriptionDialog } from "./subscription-dialog";

const moduleGate = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
});

vi.mock("@/components/subscription-dialog-content", async () => {
  await moduleGate.promise;
  return {
    SubscriptionDialogContent: () => (
      <form data-testid="subscription-dialog-real-content">
        <input aria-label="服务名称" autoFocus />
      </form>
    ),
  };
});

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "common.close": "关闭",
      "common.loading": "加载中",
      "subscription.dialogCreateDescription": "新增订阅说明",
      "subscription.dialogCreateTitle": "添加新订阅",
    }[key] ?? key),
  }),
}));

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>打开新增</button>
      <SubscriptionDialog
        loadingPreview={null}
        mode="create"
        open={open}
        onOpenChange={setOpen}
        onSubmit={vi.fn()}
      />
    </>
  );
}

describe("SubscriptionDialog loading shell", () => {
  it("resolves module pending inside the active dialog and reuses the loaded module on reopen", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const dialog = screen.getByRole("dialog", { name: "添加新订阅" });
    const overlay = document.querySelector("[data-dialog-overlay]");
    expect(overlay).toBeInstanceOf(HTMLElement);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByTestId("dialog-module-pending")).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      moduleGate.release();
      await moduleGate.promise;
    });

    expect(await screen.findByTestId("subscription-dialog-real-content")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "添加新订阅" })).toBe(dialog);
    expect(document.querySelector("[data-dialog-overlay]")).toBe(overlay);
    expect(screen.queryByTestId("dialog-module-pending")).not.toBeInTheDocument();
    expect(dialog).not.toHaveAttribute("aria-busy");
    expect(screen.getByLabelText("服务名称")).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "关闭" }));
    await user.click(screen.getByRole("button", { name: "打开新增" }));

    expect(screen.getByTestId("subscription-dialog-real-content")).toBeInTheDocument();
    expect(screen.queryByTestId("dialog-module-pending")).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
});
