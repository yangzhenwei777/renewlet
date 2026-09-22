const animationFrameResizeObserverMarker = Symbol("renewlet.animationFrameResizeObserver");

type ResizeObserverConstructor = {
  new(callback: ResizeObserverCallback): ResizeObserver;
  readonly [animationFrameResizeObserverMarker]?: true;
};

type ResizeObserverWindow = Window & {
  ResizeObserver?: ResizeObserverConstructor;
};

function requestFrame(ownerWindow: Window, callback: FrameRequestCallback): number {
  if (typeof ownerWindow.requestAnimationFrame === "function") {
    return ownerWindow.requestAnimationFrame(callback);
  }
  return ownerWindow.setTimeout(() => callback(ownerWindow.performance.now()), 0);
}

function cancelFrame(ownerWindow: Window, frameId: number): void {
  if (typeof ownerWindow.cancelAnimationFrame === "function") {
    ownerWindow.cancelAnimationFrame(frameId);
    return;
  }
  ownerWindow.clearTimeout(frameId);
}

/**
 * Floating UI、Recharts 与虚拟列表都会在尺寸通知里更新布局；统一跨帧交付可避免多个库互相触发浏览器反馈环。
 */
export function installAnimationFrameResizeObserver(ownerWindow: ResizeObserverWindow = window): void {
  const NativeResizeObserver = ownerWindow.ResizeObserver;
  if (!NativeResizeObserver || NativeResizeObserver[animationFrameResizeObserverMarker]) return;
  const ResizeObserverImpl = NativeResizeObserver;

  class AnimationFrameResizeObserver implements ResizeObserver {
    readonly #entries = new Map<Element, ResizeObserverEntry>();
    readonly #nativeObserver: ResizeObserver;
    #frameId: number | null = null;

    constructor(callback: ResizeObserverCallback) {
      this.#nativeObserver = new ResizeObserverImpl((entries) => {
        for (const entry of entries) this.#entries.set(entry.target, entry);
        if (this.#frameId !== null) return;
        this.#frameId = requestFrame(ownerWindow, () => {
          this.#frameId = null;
          if (this.#entries.size === 0) return;
          const pendingEntries = Array.from(this.#entries.values());
          this.#entries.clear();
          callback(pendingEntries, this);
        });
      });
    }

    observe(target: Element, options?: ResizeObserverOptions): void {
      if (options) {
        this.#nativeObserver.observe(target, options);
        return;
      }
      this.#nativeObserver.observe(target);
    }

    unobserve(target: Element): void {
      this.#entries.delete(target);
      this.#nativeObserver.unobserve(target);
    }

    disconnect(): void {
      this.#nativeObserver.disconnect();
      this.#entries.clear();
      if (this.#frameId === null) return;
      cancelFrame(ownerWindow, this.#frameId);
      this.#frameId = null;
    }
  }

  Object.defineProperty(AnimationFrameResizeObserver, animationFrameResizeObserverMarker, { value: true });

  Object.defineProperty(ownerWindow, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: AnimationFrameResizeObserver,
  });
}
