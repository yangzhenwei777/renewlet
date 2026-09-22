import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

function DialogHarness({
  dismissMode,
  onEscapeKeyDown,
  onInteractOutside,
  onPointerDownOutside,
}: {
  dismissMode?: "default" | "explicit";
  onEscapeKeyDown?: React.ComponentProps<typeof DialogContent>["onEscapeKeyDown"];
  onInteractOutside?: React.ComponentProps<typeof DialogContent>["onInteractOutside"];
  onPointerDownOutside?: React.ComponentProps<typeof DialogContent>["onPointerDownOutside"];
}) {
  const [open, setOpen] = React.useState(true);

  return (
    <div>
      <button type="button" data-testid="outside-button">外部按钮</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          closeLabel="关闭"
          {...(dismissMode ? { dismissMode } : {})}
          {...(onEscapeKeyDown ? { onEscapeKeyDown } : {})}
          {...(onInteractOutside ? { onInteractOutside } : {})}
          {...(onPointerDownOutside ? { onPointerDownOutside } : {})}
        >
          <DialogTitle>测试弹窗</DialogTitle>
          <DialogDescription>验证弹窗关闭模式。</DialogDescription>
          <button type="button" onClick={() => setOpen(false)}>
            取消
          </button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

describe("DialogContent dismissMode", () => {
  it("keeps default Radix dismissal for Escape and outside clicks", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "测试弹窗" })).not.toBeInTheDocument();
    });

    render(<DialogHarness />);
    const overlay = document.querySelector("[data-dialog-overlay]");
    if (!overlay) throw new Error("Dialog overlay was not rendered");

    await user.click(overlay);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "测试弹窗" })).not.toBeInTheDocument();
    });
  });

  it("requires explicit controls for Escape, outside click, and outside focus dismissal", async () => {
    const user = userEvent.setup();
    render(<DialogHarness dismissMode="explicit" />);

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "测试弹窗" })).toBeInTheDocument();

    const overlay = document.querySelector("[data-dialog-overlay]");
    if (!overlay) throw new Error("Dialog overlay was not rendered");
    await user.click(overlay);
    expect(screen.getByRole("dialog", { name: "测试弹窗" })).toBeInTheDocument();

    fireEvent.focusIn(screen.getByTestId("outside-button"));
    expect(screen.getByRole("dialog", { name: "测试弹窗" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "测试弹窗" })).not.toBeInTheDocument();
    });
  });

  it("runs caller handlers before preventing explicit dismissal", async () => {
    const user = userEvent.setup();
    const onEscapeKeyDown = vi.fn();
    const onInteractOutside = vi.fn();
    const onPointerDownOutside = vi.fn();
    render(
      <DialogHarness
        dismissMode="explicit"
        onEscapeKeyDown={onEscapeKeyDown}
        onInteractOutside={onInteractOutside}
        onPointerDownOutside={onPointerDownOutside}
      />,
    );

    await user.keyboard("{Escape}");
    const overlay = document.querySelector("[data-dialog-overlay]");
    if (!overlay) throw new Error("Dialog overlay was not rendered");
    await user.click(overlay);

    expect(onEscapeKeyDown).toHaveBeenCalled();
    expect(onInteractOutside).toHaveBeenCalled();
    expect(onPointerDownOutside).toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "测试弹窗" })).toBeInTheDocument();
  });

  it("restores focus to the trigger after the default close control dismisses", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <button type="button">打开弹窗</button>
        </DialogTrigger>
        <DialogContent closeLabel="关闭">
          <DialogTitle>焦点恢复</DialogTitle>
          <DialogDescription>关闭后回到触发控件。</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    const trigger = screen.getByRole("button", { name: "打开弹窗" });
    await user.click(trigger);
    const close = screen.getByRole("button", { name: "关闭" });
    expect(close).toHaveAttribute("data-dialog-close");
    expect(close).toHaveClass("dialog-close-touch-target", "touch-target", "right-4", "top-4");
    expect(close).not.toHaveClass("h-11", "w-11");
    await user.click(close);

    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
