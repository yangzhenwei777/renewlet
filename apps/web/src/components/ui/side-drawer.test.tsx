import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  SideDrawerClose,
  SideDrawerContent,
  SideDrawerDescription,
  SideDrawerRoot,
  SideDrawerTitle,
  SideDrawerTrigger,
} from "@/components/ui/side-drawer";

function SideDrawerHarness({ side }: { side: "left" | "right" }) {
  return (
    <SideDrawerRoot>
      <SideDrawerTrigger asChild>
        <button type="button">打开侧栏</button>
      </SideDrawerTrigger>
      <SideDrawerContent side={side} data-testid="side-drawer">
        <SideDrawerTitle>侧栏标题</SideDrawerTitle>
        <SideDrawerDescription>侧栏说明</SideDrawerDescription>
        <SideDrawerClose asChild>
          <button type="button">关闭侧栏</button>
        </SideDrawerClose>
      </SideDrawerContent>
    </SideDrawerRoot>
  );
}

function installExitAnimationStyleMock() {
  const getComputedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudoElement) => {
    const style = getComputedStyle(element, pseudoElement);
    if (
      element instanceof HTMLElement
      && (element.hasAttribute("data-side-drawer-content") || element.hasAttribute("data-side-drawer-overlay"))
    ) {
      Object.defineProperty(style, "animationName", {
        configurable: true,
        get: () => element.dataset["state"] === "closed" ? "side-drawer-test-exit" : "side-drawer-test-enter",
      });
    }
    return style;
  });
}

function finishExitAnimation(element: Element) {
  const event = new Event("animationend", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: "side-drawer-test-exit" });
  fireEvent(element, event);
}

describe("SideDrawer", () => {
  it.each([
    ["left", "left-0", "data-[state=open]:slide-in-from-left-4", "data-[state=closed]:slide-out-to-left-4", "border-r"],
    ["right", "right-0", "data-[state=open]:slide-in-from-right-4", "data-[state=closed]:slide-out-to-right-4", "border-l"],
  ] as const)("maps the %s side to matching placement and motion", async (
    side,
    placementClass,
    enterClass,
    exitClass,
    borderClass,
  ) => {
    const user = userEvent.setup();
    render(<SideDrawerHarness side={side} />);

    await user.click(screen.getByRole("button", { name: "打开侧栏" }));

    const content = screen.getByTestId("side-drawer");
    const overlay = document.querySelector("[data-side-drawer-overlay]");
    expect(content).toHaveAttribute("data-side", side);
    expect(content).toHaveAttribute("data-state", "open");
    expect(content).toHaveAttribute("role", "dialog");
    expect(content).toHaveClass(placementClass, enterClass, exitClass, borderClass, "duration-200");
    expect(overlay).toHaveAttribute("data-state", "open");
    expect(overlay).toHaveClass(
      "data-[state=open]:animate-in",
      "data-[state=closed]:animate-out",
      "data-[state=open]:fade-in-0",
      "data-[state=closed]:fade-out-0",
      "duration-200",
    );
  });

  it("keeps content and overlay mounted through the exit animation, then restores trigger focus", async () => {
    installExitAnimationStyleMock();
    const user = userEvent.setup();
    render(<SideDrawerHarness side="right" />);

    const trigger = screen.getByRole("button", { name: "打开侧栏" });
    await user.click(trigger);
    const content = screen.getByTestId("side-drawer");
    const overlay = document.querySelector<HTMLElement>("[data-side-drawer-overlay]");
    if (!overlay) throw new Error("Side drawer overlay was not rendered");
    expect(screen.getByRole("button", { name: "关闭侧栏" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "关闭侧栏" }));

    expect(content).toHaveAttribute("data-state", "closed");
    expect(overlay).toHaveAttribute("data-state", "closed");
    expect(content).toBeInTheDocument();
    expect(overlay).toBeInTheDocument();

    finishExitAnimation(content);
    finishExitAnimation(overlay);

    await waitFor(() => expect(screen.queryByTestId("side-drawer")).not.toBeInTheDocument());
    expect(document.querySelector("[data-side-drawer-overlay]")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
