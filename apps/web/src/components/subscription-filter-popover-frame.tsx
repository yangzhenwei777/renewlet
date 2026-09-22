/**
 * 订阅页桌面筛选 Popover 的唯一布局骨架。
 *
 * 分类和标签共用这里固定 header/search/footer，把滚动权收敛到内容区，
 * 避免各筛选器重新写一套高度链后又出现外框裁切、列表不滚动的问题。
 */
import type { ReactNode } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";

interface SubscriptionFilterPopoverFrameProps {
  title: ReactNode;
  searchInput?: ReactNode;
  children: ReactNode;
  closeLabel: string;
  onClose: () => void;
  footer?: ReactNode;
  contentTestId?: string;
  footerTestId?: string;
  scrollTestId?: string;
}

export function SubscriptionFilterPopoverFrame({
  title,
  searchInput,
  children,
  closeLabel,
  onClose,
  footer,
  contentTestId,
  footerTestId,
  scrollTestId,
}: SubscriptionFilterPopoverFrameProps) {
  return (
    <PopoverContent
      align="end"
      sideOffset={8}
      data-testid={contentTestId}
      className={[
        // 同时吃应用视觉视口和 Radix 可用高度，Popover 靠近屏幕边缘时也只能让内容区滚动。
        "flex max-h-[min(calc(var(--app-viewport-height)-1rem),var(--radix-popover-content-available-height,32rem))]",
        "w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden border-border bg-popover p-0 text-popover-foreground",
      ].join(" ")}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{title}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="-mr-2 h-8 w-8 text-muted-foreground"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">{closeLabel}</span>
        </Button>
      </div>

      {searchInput ? (
        <div className="shrink-0 border-b border-border px-4 py-3">
          <div className="relative">{searchInput}</div>
        </div>
      ) : null}

      <div data-testid={scrollTestId} className="min-h-0 flex-1 overflow-y-auto p-4">
        {children}
      </div>

      {footer ? (
        <div
          data-testid={footerTestId}
          className="flex shrink-0 justify-end border-t border-border bg-card px-4 py-3"
        >
          {footer}
        </div>
      ) : null}
    </PopoverContent>
  );
}
