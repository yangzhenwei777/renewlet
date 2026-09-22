/**
 * 主题风格（data-theme + custom 颜色变量）应用工具。
 *
 * 说明：
 * - `ThemeVariant` 通过 `html[data-theme=...]` 控制主题色/渐变等视觉变量
 * - `custom` 主题会写入一组 CSS 变量覆盖主色系（保持现有样式体系不变）
 *
 * 注意：
 * - 仅在浏览器端生效（依赖 document）
 * - 这是“展示层副作用”，不要在服务端调用
 */

import type { CustomThemeColor, ThemeVariant } from "@/types/theme";
import { updateBrandFavicon } from "@/lib/brand-favicon";

/** 将自定义主题色写入 CSS 变量（作用于全站）。 */
export function applyCustomTheme(color: CustomThemeColor): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const { h, s, l } = color;

  // 主色 token 会驱动按钮、链接和品牌 favicon。
  root.style.setProperty("--primary", `${h} ${s}% ${l}%`);
  root.style.setProperty("--primary-glow", `${h} ${s}% ${Math.min(l + 6, 100)}%`);
  root.style.setProperty("--ring", `${h} ${s}% ${l}%`);

  // 辅助色降低饱和度，避免自定义主题让 hover/secondary 区域过亮。
  root.style.setProperty("--accent", `${h} ${Math.max(s - 30, 20)}% 20%`);
  root.style.setProperty("--accent-foreground", `${h} ${s}% ${Math.min(l + 20, 100)}%`);

  // 自定义主题下成功色复用主色，保持单用户主题的一致视觉语义。
  root.style.setProperty("--success", `${h} ${s}% ${l}%`);

  // 预留 sidebar token，避免未来恢复侧边栏时自定义主题缺色。
  root.style.setProperty("--sidebar-primary", `${h} ${s}% ${l}%`);
  root.style.setProperty("--sidebar-ring", `${h} ${s}% ${l}%`);

  updateBrandFavicon();
}

/** 清理自定义主题色（恢复为预设主题 CSS 变量）。 */
export function clearCustomTheme(): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const properties = [
    "--primary",
    "--primary-glow",
    "--ring",
    "--accent",
    "--accent-foreground",
    "--success",
    "--sidebar-primary",
    "--sidebar-ring",
  ] as const;

  properties.forEach((prop) => root.style.removeProperty(prop));
}

/**
 * 将主题风格应用到 DOM。
 *
 * - 非 custom：只写 `data-theme`，并确保清理 custom 覆盖变量
 * - custom：写 `data-theme=custom`，并写入覆盖变量
 */
export function applyThemeVariant(variant: ThemeVariant, customColor: CustomThemeColor): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  if (variant === "custom") {
    root.setAttribute("data-theme", "custom");
    applyCustomTheme(customColor);
    return;
  }

  clearCustomTheme();
  root.setAttribute("data-theme", variant);
  updateBrandFavicon();
}
