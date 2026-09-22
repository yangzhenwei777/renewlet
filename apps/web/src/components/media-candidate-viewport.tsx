import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface MediaCandidateViewportProps {
  /** 面板内容通常包含异步加载态、分组候选和空态；调用方负责决定状态优先级。 */
  children: ReactNode;
  className?: string | undefined;
  contentClassName?: string | undefined;
  /** E2E 用稳定选择器，避免依赖 provider 文案或图片 URL 这类易变内容。 */
  dataTestId?: string | undefined;
}

/**
 * MediaCandidateViewport 固定候选区域的滚动容器结构。
 *
 * 外层 viewport 与内层 content 分离是为了让 H5 sheet、Popover 和桌面弹层共享同一套高度/
 * overscroll CSS，避免每个调用方重新处理移动端滚动边界。
 */
export function MediaCandidateViewport({
  children,
  className,
  contentClassName,
  dataTestId,
}: MediaCandidateViewportProps) {
  return (
    <div className={cn("media-candidate-scroll-viewport", className)} data-testid={dataTestId}>
      <div className={cn("media-candidate-scroll-content", contentClassName)}>
        {children}
      </div>
    </div>
  );
}
