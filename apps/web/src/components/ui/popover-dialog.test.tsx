// Popover/Dialog 组合测试保护移动端浮层栈与 backdrop 行为，避免 Radix portal 交互互相吞事件。
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { mockMobileOverlayMatch, resetMobileOverlayTestEnvironment } from "@/components/ui/mobile-overlay.test-utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

async function finishMobileSheetExit() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

describe("Popover inside Dialog", () => {
  beforeEach(() => {
    mockMobileOverlayMatch();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetMobileOverlayTestEnvironment();
  });

  it("portals popover content into the dialog content", async () => {
    render(
      <Dialog open>
        <DialogContent data-testid="dialog-content">
          <DialogTitle className="sr-only">嵌套弹窗测试</DialogTitle>
          <DialogDescription className="sr-only">验证弹窗内的浮层挂载位置。</DialogDescription>
          <Popover open>
            <PopoverTrigger asChild>
              <button type="button">打开</button>
            </PopoverTrigger>
            <PopoverContent data-testid="popover-content">嵌套弹窗</PopoverContent>
          </Popover>
        </DialogContent>
      </Dialog>,
    );

    const dialogContent = await screen.findByTestId("dialog-content");
    const popoverContent = await screen.findByTestId("popover-content");

    await waitFor(() => {
      expect(dialogContent).toContainElement(popoverContent);
    });
    const portalHost = popoverContent.closest("[data-mobile-overlay-portal]");
    expect(portalHost).toHaveClass("contents");
    expect(dialogContent.querySelector("[data-mobile-overlay-backdrop]")).not.toBeNull();
    expect(popoverContent).toHaveAttribute("data-vaul-drawer");
    expect(popoverContent).toHaveClass("h5-mobile-sheet-content");
    expect(portalHost?.querySelector("[data-vaul-handle]")).not.toBeNull();
  });

  it("closes the mobile sheet without dismissing the parent dialog or clicking behind it", async () => {
    const behindClick = vi.fn();

    function Harness() {
      const [popoverOpen, setPopoverOpen] = React.useState(false);

      return (
        <Dialog open>
          <DialogContent>
            <DialogTitle>添加新订阅</DialogTitle>
            <DialogDescription className="sr-only">验证背景事件不穿透。</DialogDescription>
            <button type="button" onClick={behindClick}>
              到期提醒
            </button>
            <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
              <PopoverTrigger asChild>
                <button type="button">打开提醒</button>
              </PopoverTrigger>
              <PopoverContent data-testid="reminder-popover">提前 3 天</PopoverContent>
            </Popover>
          </DialogContent>
        </Dialog>
      );
    }

    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "打开提醒" }));
    const popoverContent = await screen.findByTestId("reminder-popover");
    const backdrop = popoverContent.closest("[data-mobile-overlay-portal]")?.querySelector("[data-mobile-overlay-backdrop]");
    expect(backdrop).not.toBeNull();

    vi.useFakeTimers();
    fireEvent.pointerDown(backdrop as Element);
    expect(screen.getByTestId("reminder-popover")).toBeInTheDocument();
    fireEvent.click(backdrop as Element);

    expect(screen.getByTestId("reminder-popover")).toHaveAttribute("data-state", "closed");
    await finishMobileSheetExit();
    expect(screen.queryByTestId("reminder-popover")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "添加新订阅" })).toBeVisible();
    expect(behindClick).not.toHaveBeenCalled();
  });
});
