// 滚动锁测试固定 Renewlet 的真实滚动根 #root、多锁计数和 inline style 恢复，避免弹层回退到 body/window 假设。
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useAppRootScrollLock } from "./use-app-root-scroll-lock";

function ScrollLockHarness({ locked }: { locked: boolean }) {
  useAppRootScrollLock(locked);
  return <div>scroll lock harness</div>;
}

function renderWithAppRoot(ui: ReactElement, setupRoot?: (root: HTMLElement) => void) {
  const root = document.createElement("div");
  root.id = "root";
  setupRoot?.(root);
  document.body.appendChild(root);

  return {
    root,
    ...render(ui, { container: root }),
  };
}

describe("useAppRootScrollLock", () => {
  afterEach(() => {
    document.getElementById("root")?.remove();
  });

  it("locks and restores the app scroll root styles", () => {
    const { root, rerender } = renderWithAppRoot(<ScrollLockHarness locked={false} />, (element) => {
      element.style.overflowY = "auto";
      element.style.overscrollBehaviorY = "contain";
      element.scrollTop = 320;
    });

    rerender(<ScrollLockHarness locked />);

    expect(root).toHaveStyle({ overflowY: "hidden", overscrollBehaviorY: "none" });
    expect(root).toHaveAttribute("data-app-scroll-locked");
    expect(root.scrollTop).toBe(320);

    rerender(<ScrollLockHarness locked={false} />);

    expect(root).toHaveStyle({ overflowY: "auto", overscrollBehaviorY: "contain" });
    expect(root).not.toHaveAttribute("data-app-scroll-locked");
    expect(root.scrollTop).toBe(320);
  });

  it("keeps the root locked until every lock is released", () => {
    const { root, rerender } = renderWithAppRoot(
      <>
        <ScrollLockHarness locked />
        <ScrollLockHarness locked />
      </>,
      (element) => {
        element.style.overflowY = "auto";
      },
    );

    expect(root).toHaveStyle({ overflowY: "hidden" });

    rerender(
      <>
        <ScrollLockHarness locked />
        <ScrollLockHarness locked={false} />
      </>,
    );

    expect(root).toHaveStyle({ overflowY: "hidden" });
    expect(root).toHaveAttribute("data-app-scroll-locked");

    rerender(
      <>
        <ScrollLockHarness locked={false} />
        <ScrollLockHarness locked={false} />
      </>,
    );

    expect(root).toHaveStyle({ overflowY: "auto" });
    expect(root).not.toHaveAttribute("data-app-scroll-locked");
  });

  it("does not crash when the app scroll root is missing", () => {
    expect(() => render(<ScrollLockHarness locked />)).not.toThrow();
  });
});
