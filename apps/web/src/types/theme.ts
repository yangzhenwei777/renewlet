/**
 * 外观/主题相关的领域类型（可持久化到数据库）。
 *
 * 说明：
 * - `ThemeMode` 对应本地 ThemeProvider 的 theme（light/dark/system）
 * - `ThemeVariant` 对应 `html[data-theme=...]`（控制主题色/渐变等视觉变量）
 * - `CustomThemeColor` 用于 custom 主题：通过 CSS 变量覆盖主色系
 */

/** 明暗模式（对应本地 ThemeProvider 的 theme 值）。 */
export const THEME_MODES = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** 已解析明暗模式（对应当前实际渲染外观；Turnstile 这类第三方 iframe 只能消费该值）。 */
export type ResolvedThemeMode = Exclude<ThemeMode, "system">;

/** 主题风格（对应 `html[data-theme=...]`）。 */
export const THEME_VARIANTS = ["emerald", "ocean", "sunset", "lavender", "rose", "custom"] as const;
export type ThemeVariant = (typeof THEME_VARIANTS)[number];

/** 自定义主题色（HSL）。 */
export interface CustomThemeColor {
  /** Hue：色相（0-360）。 */
  h: number;
  /** Saturation：饱和度（0-100）。 */
  s: number;
  /** Lightness：亮度（0-100）。 */
  l: number;
}

/** 默认自定义主题色：与 emerald 主色保持一致。 */
export const DEFAULT_CUSTOM_THEME_COLOR: CustomThemeColor = { h: 160, s: 84, l: 39 };
