/**
 * 表单错误展示原语。
 *
 * 架构位置：上层表单负责校验和本地化，本组件只统一错误文本的视觉层级与 aria 语义。
 *
 * 注意： 错误归一化应在 domain/hook 边界完成，这里只接收最终展示文案。
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function FieldError({
  id,
  message,
  className,
}: {
  id: string;
  message?: ReactNode | undefined;
  className?: string | undefined;
}) {
  if (!message) return null;

  return (
    <p id={id} role="alert" className={cn("text-xs text-destructive", className)}>
      {message}
    </p>
  );
}
