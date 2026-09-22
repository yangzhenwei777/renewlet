import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BackToTopFloatButton } from "./back-to-top-float-button";

function mockMatchMedia(reducedMotion = false) {
  // jsdom 没有真实的媒体查询环境；这里手动模拟 reduced motion，确保滚动动画分支可被稳定覆盖。
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" ? reducedMotion : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function setScrollMetrics(element: HTMLElement, options: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}) {
  // jsdom 不做真实布局计算，scrollHeight/clientHeight 默认不可信；测试里显式定义才能验证可滚动判断。
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: options.scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: options.clientHeight,
  });
  element.scrollTop = options.scrollTop;
}

function renderBackToTop() {
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);

  const result = render(
    <TooltipProvider delayDuration={0}>
      <BackToTopFloatButton />
    </TooltipProvider>,
    { container: root },
  );

  return { root, ...result };
}

describe("BackToTopFloatButton", () => {
  beforeEach(() => {
    mockMatchMedia(false);
  });

  it("stays hidden before the visibility threshold", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    setScrollMetrics(root, { scrollTop: 399, scrollHeight: 1200, clientHeight: 800 });

    render(
      <TooltipProvider delayDuration={0}>
        <BackToTopFloatButton />
      </TooltipProvider>,
      { container: root },
    );

    expect(screen.queryByRole("button", { name: "回到顶部" })).not.toBeInTheDocument();
  });

  it("appears after scrolling past the visibility threshold", async () => {
    const { root } = renderBackToTop();
    setScrollMetrics(root, { scrollTop: 401, scrollHeight: 1200, clientHeight: 800 });

    fireEvent.scroll(root);

    expect(await screen.findByRole("button", { name: "回到顶部" })).toBeInTheDocument();
  });

  it("stays hidden when the target is not scrollable", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    setScrollMetrics(root, { scrollTop: 600, scrollHeight: 800, clientHeight: 800 });

    render(
      <TooltipProvider delayDuration={0}>
        <BackToTopFloatButton />
      </TooltipProvider>,
      { container: root },
    );

    expect(screen.queryByRole("button", { name: "回到顶部" })).not.toBeInTheDocument();
  });

  it("scrolls the app root to the top with smooth motion by default", async () => {
    const user = userEvent.setup();
    const { root } = renderBackToTop();
    const scrollTo = vi.fn();
    root.scrollTo = scrollTo;
    setScrollMetrics(root, { scrollTop: 420, scrollHeight: 1200, clientHeight: 800 });

    fireEvent.scroll(root);
    await user.click(await screen.findByRole("button", { name: "回到顶部" }));

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("uses instant scrolling when reduced motion is requested", async () => {
    mockMatchMedia(true);
    const user = userEvent.setup();
    const { root } = renderBackToTop();
    const scrollTo = vi.fn();
    root.scrollTo = scrollTo;
    setScrollMetrics(root, { scrollTop: 420, scrollHeight: 1200, clientHeight: 800 });

    fireEvent.scroll(root);
    await user.click(await screen.findByRole("button", { name: "回到顶部" }));

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });

  it("does not render when disabled", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    setScrollMetrics(root, { scrollTop: 420, scrollHeight: 1200, clientHeight: 800 });

    render(
      <TooltipProvider delayDuration={0}>
        <BackToTopFloatButton enabled={false} />
      </TooltipProvider>,
      { container: root },
    );
    fireEvent.scroll(root);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "回到顶部" })).not.toBeInTheDocument();
    });
  });
});
