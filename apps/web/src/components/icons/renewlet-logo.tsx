/**
 * 品牌符号组件（Renewlet）。
 *
 * 架构位置：所有登录/setup/空状态入口共用同一个 SVG，避免品牌图形在页面中复制分叉。
 *
 * 注意： SVG 使用 currentColor 继承外层主题色；不要在组件内写死颜色。
 */
import type { SVGProps } from "react";

/** 渲染 Ledger Sans 风格的 Renewlet 品牌符号。 */
export function RenewletLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <rect x="2" y="5" width="14" height="4" rx="2" fill="currentColor" />
      <circle cx="20" cy="7" r="2" fill="hsl(var(--primary))" />
      <rect x="4" y="14" width="14.5" height="3" rx="1.5" fill="hsl(var(--primary))" />
    </svg>
  );
}
