/**
 * 骨架屏设计系统原语。
 *
 * 架构位置：只渲染基础占位单元，页面级骨架布局由 `loading-skeleton.tsx` 组合。
 *
 * 注意： 占位尺寸应由调用方控制；组件内部不推断业务布局，避免加载态造成布局跳动。
 */
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 骨架屏占位组件（骨架屏的基础单元）。
 *
 * 说明：
 * - 只负责渲染一块带 `animate-pulse` 的灰色背景
 * - 具体页面级骨架布局由 `src/components/loading-skeleton.tsx` 组合
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}
