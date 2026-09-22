/**
 * 共享的“回到顶部”悬浮按钮。
 *
 * 全局样式把 body 锁定为不滚动，页面滚动实际发生在 `#root` 上；这里固定以
 * `#root` 为默认目标，避免监听 window 后按钮状态和真实滚动位置不同步。
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";

const DEFAULT_VISIBILITY_HEIGHT = 400;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type BackToTopFloatButtonProps = {
  enabled?: boolean | undefined;
  visibilityHeight?: number | undefined;
  bottomOffsetClassName?: string | undefined;
  className?: string | undefined;
  getScrollElement?: (() => HTMLElement | null) | undefined;
};

function getRootScrollElement() {
  return typeof document === "undefined" ? null : document.getElementById("root");
}

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function isScrollable(element: HTMLElement) {
  // 浏览器布局和 jsdom mock 可能产生小于 1px 的测量误差；保留 1px 容错，避免内容刚好等高时误判可滚动。
  return element.scrollHeight - element.clientHeight > 1;
}

function observeScrollSize(scrollElement: HTMLElement, onChange: () => void) {
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(onChange);
    resizeObserver.observe(scrollElement);
    // 只观察根容器和第一层子节点：足够捕捉页面主体高度变化，也避免深层遍历带来的 observer 数量膨胀。
    Array.from(scrollElement.children).forEach((child) => {
      if (child instanceof HTMLElement) resizeObserver?.observe(child);
    });
  }

  if (typeof MutationObserver !== "undefined") {
    mutationObserver = new MutationObserver(() => {
      if (resizeObserver) {
        // 页面可能在加载数据后替换主内容节点；新增子节点需要补挂 ResizeObserver，否则按钮可见性会滞后。
        Array.from(scrollElement.children).forEach((child) => {
          if (child instanceof HTMLElement) resizeObserver?.observe(child);
        });
      }
      onChange();
    });
    mutationObserver.observe(scrollElement, { childList: true });
  }

  return () => {
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
  };
}

export function BackToTopFloatButton({
  enabled = true,
  visibilityHeight = DEFAULT_VISIBILITY_HEIGHT,
  bottomOffsetClassName,
  className,
  getScrollElement,
}: BackToTopFloatButtonProps) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const label = t("common.backToTop");
  const resolveScrollElement = useCallback(
    () => getScrollElement?.() ?? getRootScrollElement(),
    [getScrollElement],
  );

  useEffect(() => {
    if (!enabled) {
      // 禁用时主动隐藏，防止页面从启用切到禁用后残留上一轮滚动状态。
      setVisible(false);
      return undefined;
    }

    const scrollElement = resolveScrollElement();
    if (!scrollElement) {
      // 测试、SSR 或极早期渲染阶段可能拿不到 #root；保持隐藏比绑定错误目标更安全。
      setVisible(false);
      return undefined;
    }

    const updateVisibility = () => {
      setVisible(isScrollable(scrollElement) && scrollElement.scrollTop >= visibilityHeight);
    };

    updateVisibility();
    scrollElement.addEventListener("scroll", updateVisibility, { passive: true });
    const ownerWindow = scrollElement.ownerDocument.defaultView ?? window;
    ownerWindow.addEventListener("resize", updateVisibility);
    // 列表筛选、设置项展开等会改变页面高度；同步监听尺寸变化，避免只在滚动后才刷新按钮状态。
    const disconnectScrollSizeObserver = observeScrollSize(scrollElement, updateVisibility);

    return () => {
      scrollElement.removeEventListener("scroll", updateVisibility);
      ownerWindow.removeEventListener("resize", updateVisibility);
      disconnectScrollSizeObserver();
    };
  }, [enabled, resolveScrollElement, visibilityHeight]);

  const handleClick = () => {
    const scrollElement = resolveScrollElement();
    if (!scrollElement) return;

    scrollElement.scrollTo({
      top: 0,
      // 尊重系统“减少动态效果”设置，避免强制平滑滚动造成眩晕或不适。
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  };

  if (!visible) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={label}
          onClick={handleClick}
          className={cn(
            "fixed right-[calc(1rem+env(safe-area-inset-right))] bottom-[calc(1rem+env(safe-area-inset-bottom))] z-40 h-11 w-11 rounded-full border-border bg-card/95 text-foreground shadow-[0_16px_34px_-20px_hsl(var(--foreground)/0.55)] backdrop-blur-xl transition-all hover:border-primary/40 hover:bg-accent hover:text-accent-foreground sm:right-6 sm:bottom-6",
            "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2",
            bottomOffsetClassName,
            className,
          )}
        >
          <ArrowUp className="h-4 w-4" />
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
