import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installAnimationFrameResizeObserver } from "./animation-frame-resize-observer";

let resizeObserverDescriptor: PropertyDescriptor | undefined;
let requestAnimationFrameDescriptor: PropertyDescriptor | undefined;
let cancelAnimationFrameDescriptor: PropertyDescriptor | undefined;
let nativeCallback: ResizeObserverCallback | null;
let nextFrameId: number;
let scheduledFrames: Map<number, FrameRequestCallback>;

const nativeObserverArgument: ResizeObserver = {
  observe() {},
  unobserve() {},
  disconnect() {},
};

class NativeResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    nativeCallback = callback;
  }

  observe() {}
  unobserve() {}
  disconnect() {}
}

function restoreWindowProperty(name: "ResizeObserver" | "requestAnimationFrame" | "cancelAnimationFrame", descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(window, name, descriptor);
    return;
  }
  Reflect.deleteProperty(window, name);
}

function emitNativeEntries(entries: ResizeObserverEntry[]) {
  const callback = nativeCallback;
  if (!callback) throw new Error("Native ResizeObserver was not constructed");
  callback(entries, nativeObserverArgument);
}

function createEntry(target: Element, width: number): ResizeObserverEntry {
  const size: ResizeObserverSize = { inlineSize: width, blockSize: 40 };
  return {
    target,
    contentRect: new DOMRectReadOnly(0, 0, width, 40),
    borderBoxSize: [size],
    contentBoxSize: [size],
    devicePixelContentBoxSize: [size],
  };
}

function flushFrames() {
  const frames = Array.from(scheduledFrames.values());
  scheduledFrames.clear();
  for (const frame of frames) frame(performance.now());
}

describe("installAnimationFrameResizeObserver", () => {
  beforeEach(() => {
    resizeObserverDescriptor = Object.getOwnPropertyDescriptor(window, "ResizeObserver");
    requestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(window, "requestAnimationFrame");
    cancelAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(window, "cancelAnimationFrame");
    nativeCallback = null;
    nextFrameId = 1;
    scheduledFrames = new Map();

    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: NativeResizeObserver,
    });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: (callback: FrameRequestCallback) => {
        const frameId = nextFrameId;
        nextFrameId += 1;
        scheduledFrames.set(frameId, callback);
        return frameId;
      },
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      writable: true,
      value: (frameId: number) => scheduledFrames.delete(frameId),
    });
  });

  afterEach(() => {
    restoreWindowProperty("ResizeObserver", resizeObserverDescriptor);
    restoreWindowProperty("requestAnimationFrame", requestAnimationFrameDescriptor);
    restoreWindowProperty("cancelAnimationFrame", cancelAnimationFrameDescriptor);
  });

  it("delivers the latest entry for each target on the next animation frame", () => {
    installAnimationFrameResizeObserver();
    const target = document.createElement("div");
    const firstEntry = createEntry(target, 100);
    const latestEntry = createEntry(target, 120);
    const deliveries: ResizeObserverEntry[][] = [];
    let deliveredObserver: ResizeObserver | null = null;
    const observer = new ResizeObserver((entries, currentObserver) => {
      deliveries.push(entries);
      deliveredObserver = currentObserver;
    });

    emitNativeEntries([firstEntry]);
    emitNativeEntries([latestEntry]);

    expect(deliveries).toEqual([]);
    expect(scheduledFrames.size).toBe(1);
    flushFrames();
    expect(deliveries).toEqual([[latestEntry]]);
    expect(deliveredObserver).toBe(observer);
  });

  it("drops an unobserved target from the pending delivery", () => {
    installAnimationFrameResizeObserver();
    const target = document.createElement("div");
    const deliveries: ResizeObserverEntry[][] = [];
    const observer = new ResizeObserver((entries) => deliveries.push(entries));

    emitNativeEntries([createEntry(target, 100)]);
    observer.unobserve(target);
    flushFrames();

    expect(deliveries).toEqual([]);
  });

  it("cancels a pending frame when disconnected", () => {
    installAnimationFrameResizeObserver();
    const target = document.createElement("div");
    const deliveries: ResizeObserverEntry[][] = [];
    const observer = new ResizeObserver((entries) => deliveries.push(entries));

    emitNativeEntries([createEntry(target, 100)]);
    observer.disconnect();

    expect(scheduledFrames.size).toBe(0);
    flushFrames();
    expect(deliveries).toEqual([]);
  });

  it("does not wrap an already installed constructor again", () => {
    installAnimationFrameResizeObserver();
    const installedConstructor = globalThis.ResizeObserver;

    installAnimationFrameResizeObserver();

    expect(globalThis.ResizeObserver).toBe(installedConstructor);
  });
});
