/**
 * 截断文本 Tooltip 组件。
 *
 * 架构位置：用于服务名、URL、通知结果等不可控长度文本，保持表格/卡片不被长词撑开。
 *
 * 注意： 只在实际溢出时展示 tooltip，避免密集列表里制造大量无效浮层。
 */
import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type TooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipContent>;
type TruncatedTextElement = "span" | "div" | "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

export type TruncatedTooltipTextProps = {
  text: string;
  as?: TruncatedTextElement;
  className?: string;
  tooltipClassName?: string;
  side?: TooltipContentProps["side"];
  align?: TooltipContentProps["align"];
  disabled?: boolean;
};

function isTextOverflowing(node: HTMLElement) {
  return node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;
}

export function TruncatedTooltipText({
  text,
  as = "span",
  className,
  tooltipClassName,
  side = "top",
  align = "center",
  disabled = false,
}: TruncatedTooltipTextProps) {
  const nodeRef = React.useRef<HTMLElement | null>(null);
  const [open, setOpen] = React.useState(false);

  const measureOverflow = React.useCallback(() => {
    const node = nodeRef.current;
    if (!node || disabled || !text) {
      return false;
    }

    return isTextOverflowing(node);
  }, [disabled, text]);

  const setNodeRef = React.useCallback(
    (nextNode: HTMLElement | null) => {
      nodeRef.current = nextNode;
    },
    [],
  );

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen && measureOverflow());
    },
    [measureOverflow],
  );

  const element = React.createElement(as, {
    ref: setNodeRef,
    className: cn("block max-w-full truncate", className),
    "data-slot": "truncated-tooltip-text",
  }, text);

  if (disabled || !text) {
    return element;
  }

  return (
    <Tooltip open={open} onOpenChange={handleOpenChange}>
      <TooltipTrigger asChild>{element}</TooltipTrigger>
      <TooltipContent
        side={side}
        align={align}
        className={cn("max-w-[calc(100vw-2rem)] whitespace-normal wrap-break-word text-xs leading-relaxed sm:max-w-md", tooltipClassName)}
      >
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
