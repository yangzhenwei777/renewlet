/**
 * 自定义配置图标选择器懒加载边界。
 *
 * 架构位置：排序项和新增表单共用这里加载 IconPicker，避免两个 presentation 组件各自引入
 * 图标搜索、上传和裁剪相关依赖。
 *
 * PERF： 保持懒加载可以降低 Settings 首屏 bundle；不要在父组件静态 import IconPicker。
 */
import { lazy } from "react";
import { cn } from "@/lib/utils";

const loadIconPicker = () => import("@/components/icon-picker");

export const LazyIconPicker = lazy(() => loadIconPicker().then((mod) => ({ default: mod.IconPicker })));

/** 预热图标选择器 chunk，降低用户进入编辑态后的等待时间。 */
export const preloadIconPicker = () => {
  void loadIconPicker();
};

export interface IconPickerFallbackProps {
  size: "sm" | "md";
}

/** IconPickerFallback 保持懒加载期间的布局尺寸，避免表单控件跳动。 */
export function IconPickerFallback({ size }: IconPickerFallbackProps) {
  const iconSize = size === "sm" ? "w-8 h-8" : "w-10 h-10";
  return (
    <div className="flex items-center gap-2">
      <div className={cn("shrink-0 rounded-lg border border-border bg-secondary/50", iconSize)} />
      <div className="h-6 w-20 rounded-md bg-secondary/60" />
    </div>
  );
}
