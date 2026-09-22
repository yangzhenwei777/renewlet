import { useEffect } from "react";

const APP_VIEWPORT_HEIGHT_VAR = "--app-viewport-height";
const APP_LAYOUT_VIEWPORT_HEIGHT_VAR = "--app-layout-viewport-height";
const APP_VISUAL_VIEWPORT_OFFSET_LEFT_VAR = "--app-visual-viewport-offset-left";
const APP_VISUAL_VIEWPORT_OFFSET_TOP_VAR = "--app-visual-viewport-offset-top";
const KEYBOARD_VIEWPORT_SETTLE_DELAYS_MS = [80, 240, 480];

function clampMetric(value: number | undefined, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * ViewportHeightSync 将移动浏览器 visual viewport 同步为 CSS 变量。
 *
 * iOS/Android 软键盘会分多帧提交 viewport、focus 和滚动状态；这些变量让 Dialog/Drawer
 * 使用同一套“当前可见高度”，避免表单底部按钮被键盘或地址栏遮住。
 */
export function ViewportHeightSync() {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let frame = 0;
    let settleTimers: number[] = [];
    let layoutViewportCap = Math.max(window.innerHeight, root.clientHeight);

    const readViewportMetrics = () => {
      const visualHeight = viewport?.height;
      const rawLayoutHeight = Math.max(window.innerHeight, root.clientHeight);
      if (rawLayoutHeight > layoutViewportCap) {
        layoutViewportCap = rawLayoutHeight;
      }

      if (typeof visualHeight === "number" && Number.isFinite(visualHeight) && visualHeight > 0) {
        const height = Math.min(visualHeight, layoutViewportCap);
        const offsetTop = clampMetric(viewport?.offsetTop, 0, Math.max(0, layoutViewportCap - height));
        const layoutHeight = Math.max(rawLayoutHeight, Math.min(layoutViewportCap, offsetTop + height));

        return {
          height,
          layoutHeight,
          offsetLeft: clampMetric(viewport?.offsetLeft, 0, Number.POSITIVE_INFINITY),
          offsetTop,
        };
      }

      return {
        height: rawLayoutHeight,
        layoutHeight: rawLayoutHeight,
        offsetLeft: 0,
        offsetTop: 0,
      };
    };

    const writeViewportMetrics = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const { height, layoutHeight, offsetLeft, offsetTop } = readViewportMetrics();
        root.style.setProperty(APP_VIEWPORT_HEIGHT_VAR, `${Math.round(height)}px`);
        root.style.setProperty(APP_LAYOUT_VIEWPORT_HEIGHT_VAR, `${Math.round(layoutHeight)}px`);
        root.style.setProperty(APP_VISUAL_VIEWPORT_OFFSET_LEFT_VAR, `${Math.round(offsetLeft)}px`);
        root.style.setProperty(APP_VISUAL_VIEWPORT_OFFSET_TOP_VAR, `${Math.round(offsetTop)}px`);
      });
    };

    const clearSettleTimers = () => {
      settleTimers.forEach((timer) => window.clearTimeout(timer));
      settleTimers = [];
    };

    const syncViewportHeight = () => {
      clearSettleTimers();
      writeViewportMetrics();
      // 软键盘动画结束时间不稳定，分段补采样比固定等一帧更能覆盖 WebView 和 iOS Safari。
      settleTimers = KEYBOARD_VIEWPORT_SETTLE_DELAYS_MS.map((delay) => window.setTimeout(writeViewportMetrics, delay));
    };

    const syncAfterOrientationChange = () => {
      layoutViewportCap = Math.max(window.innerHeight, root.clientHeight);
      syncViewportHeight();
    };

    syncViewportHeight();

    // iOS/Android 软键盘会先改变 visual viewport，再分批提交 layout viewport/focus 状态。
    // 这里把 visual viewport 矩形归一化到已知 layout viewport 范围内，避免键盘收起后
    // stale innerHeight 或 offsetTop 把 fixed Dialog 长时间锁在旧键盘位置。
    viewport?.addEventListener("resize", syncViewportHeight);
    viewport?.addEventListener("scroll", syncViewportHeight);
    viewport?.addEventListener("scrollend", syncViewportHeight);
    window.addEventListener("resize", syncViewportHeight);
    window.addEventListener("orientationchange", syncAfterOrientationChange);
    document.addEventListener("focusin", syncViewportHeight, true);
    document.addEventListener("focusout", syncViewportHeight, true);

    return () => {
      clearSettleTimers();
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", syncViewportHeight);
      viewport?.removeEventListener("scroll", syncViewportHeight);
      viewport?.removeEventListener("scrollend", syncViewportHeight);
      window.removeEventListener("resize", syncViewportHeight);
      window.removeEventListener("orientationchange", syncAfterOrientationChange);
      document.removeEventListener("focusin", syncViewportHeight, true);
      document.removeEventListener("focusout", syncViewportHeight, true);
      root.style.removeProperty(APP_VIEWPORT_HEIGHT_VAR);
      root.style.removeProperty(APP_LAYOUT_VIEWPORT_HEIGHT_VAR);
      root.style.removeProperty(APP_VISUAL_VIEWPORT_OFFSET_LEFT_VAR);
      root.style.removeProperty(APP_VISUAL_VIEWPORT_OFFSET_TOP_VAR);
    };
  }, []);

  return null;
}
