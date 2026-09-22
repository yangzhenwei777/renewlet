// ViewportHeightSync 测试保护 visualViewport CSS 变量，移动端软键盘布局依赖这些变量稳定更新。
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewportHeightSync } from "./viewport-height-sync";

type VisualViewportEventName = "resize" | "scroll" | "scrollend";

const originalInnerHeight = window.innerHeight;
const originalVisualViewportDescriptor = Object.getOwnPropertyDescriptor(window, "visualViewport");

function setViewportMetric(name: "innerHeight" | "clientHeight", value: number) {
  const target = name === "innerHeight" ? window : document.documentElement;
  Object.defineProperty(target, name, {
    configurable: true,
    value,
  });
}

function installVisualViewport(initialHeight: number) {
  let height = initialHeight;
  let offsetLeft = 0;
  let offsetTop = 0;
  const listeners = new Map<VisualViewportEventName, Set<EventListenerOrEventListenerObject>>();
  const viewport = {
    get height() {
      return height;
    },
    get offsetLeft() {
      return offsetLeft;
    },
    get offsetTop() {
      return offsetTop;
    },
    addEventListener: vi.fn((type: VisualViewportEventName, listener: EventListenerOrEventListenerObject) => {
      listeners.set(type, listeners.get(type) ?? new Set());
      listeners.get(type)?.add(listener);
    }),
    removeEventListener: vi.fn((type: VisualViewportEventName, listener: EventListenerOrEventListenerObject) => {
      listeners.get(type)?.delete(listener);
    }),
  };

  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });

  return {
    setHeight(nextHeight: number) {
      height = nextHeight;
    },
    setOffset(nextOffset: { left?: number; top?: number }) {
      offsetLeft = nextOffset.left ?? offsetLeft;
      offsetTop = nextOffset.top ?? offsetTop;
    },
    dispatch(type: VisualViewportEventName) {
      for (const listener of listeners.get(type) ?? []) {
        if (typeof listener === "function") {
          listener(new Event(type));
        } else {
          listener.handleEvent(new Event(type));
        }
      }
    },
  };
}

function flushViewportSync() {
  act(() => {
    vi.advanceTimersByTime(16);
  });
}

describe("ViewportHeightSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => (
      window.setTimeout(() => callback(performance.now()), 0)
    ));
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
      window.clearTimeout(handle);
    });
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--app-viewport-height");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    Reflect.deleteProperty(document.documentElement, "clientHeight");
    if (originalVisualViewportDescriptor) {
      Object.defineProperty(window, "visualViewport", originalVisualViewportDescriptor);
    } else {
      Reflect.deleteProperty(window, "visualViewport");
    }
  });

  it("restores to visual viewport height when keyboard close leaves innerHeight stale", () => {
    setViewportMetric("innerHeight", 720);
    setViewportMetric("clientHeight", 720);
    const viewport = installVisualViewport(720);

    render(<ViewportHeightSync />);
    flushViewportSync();
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("720px");

    act(() => {
      setViewportMetric("innerHeight", 360);
      viewport.setHeight(360);
      viewport.setOffset({ top: 12 });
      viewport.dispatch("resize");
    });
    flushViewportSync();
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("360px");
    expect(document.documentElement.style.getPropertyValue("--app-layout-viewport-height")).toBe("720px");
    expect(document.documentElement.style.getPropertyValue("--app-visual-viewport-offset-top")).toBe("12px");

    act(() => {
      viewport.setHeight(720);
      viewport.setOffset({ top: 0 });
      viewport.dispatch("scrollend");
    });
    flushViewportSync();
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("720px");
    expect(document.documentElement.style.getPropertyValue("--app-layout-viewport-height")).toBe("720px");
  });

  it("normalizes stale visual viewport offsets after the keyboard closes", () => {
    setViewportMetric("innerHeight", 720);
    setViewportMetric("clientHeight", 720);
    const viewport = installVisualViewport(720);

    render(<ViewportHeightSync />);
    flushViewportSync();

    act(() => {
      viewport.setHeight(360);
      viewport.setOffset({ top: 280 });
      viewport.dispatch("resize");
    });
    flushViewportSync();
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("360px");
    expect(document.documentElement.style.getPropertyValue("--app-visual-viewport-offset-top")).toBe("280px");

    act(() => {
      viewport.setHeight(720);
      viewport.setOffset({ top: 280 });
      viewport.dispatch("resize");
    });
    flushViewportSync();
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("720px");
    expect(document.documentElement.style.getPropertyValue("--app-visual-viewport-offset-top")).toBe("0px");
  });

  it("rebuilds layout bounds from the restored visual viewport when innerHeight lags behind", () => {
    setViewportMetric("innerHeight", 720);
    setViewportMetric("clientHeight", 720);
    const viewport = installVisualViewport(720);

    render(<ViewportHeightSync />);
    flushViewportSync();

    act(() => {
      setViewportMetric("innerHeight", 360);
      setViewportMetric("clientHeight", 360);
      viewport.setHeight(360);
      viewport.dispatch("resize");
    });
    flushViewportSync();

    act(() => {
      viewport.setHeight(720);
      viewport.dispatch("resize");
    });
    flushViewportSync();
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("720px");
    expect(document.documentElement.style.getPropertyValue("--app-layout-viewport-height")).toBe("720px");
  });

  it("caps simulator visual viewport values that exceed the layout viewport", () => {
    setViewportMetric("innerHeight", 640);
    setViewportMetric("clientHeight", 640);
    installVisualViewport(700);

    render(<ViewportHeightSync />);
    flushViewportSync();

    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("640px");
  });
});
