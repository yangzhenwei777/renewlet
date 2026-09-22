/**
 * UI 工具集合。
 *
 * 当前只提供 `cn`，集中合并 clsx 与 tailwind-merge，避免组件里重复处理 Tailwind 冲突。
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 className 工具：
 * - clsx：处理条件 class / 数组 / 对象写法
 * - tailwind-merge：解决 Tailwind class 冲突（后者覆盖前者）
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
