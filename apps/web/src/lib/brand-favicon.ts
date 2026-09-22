/**
 * 品牌 favicon 动态生成工具。
 *
 * 架构位置：ThemeProvider 在主题色变化时调用这里，把 CSS token 转成 data URL favicon，
 * 让浏览器标签页与当前主题保持一致。
 *
 * 注意： 该模块依赖 DOM/CSSOM；服务端或测试环境调用时必须走 fallback。
 */
const FALLBACK_PRIMARY = "160 84% 39%";
const FALLBACK_GLOW = "160 84% 45%";

function readCssHsl(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function ensureFaviconLink(): HTMLLinkElement {
  const existing =
    document.querySelector<HTMLLinkElement>("#renewlet-favicon") ??
    document.querySelector<HTMLLinkElement>('link[rel="icon"]');

  if (existing) {
    existing.id = "renewlet-favicon";
    existing.rel = "icon";
    existing.type = "image/svg+xml";
    return existing;
  }

  const link = document.createElement("link");
  link.id = "renewlet-favicon";
  link.rel = "icon";
  link.type = "image/svg+xml";
  document.head.appendChild(link);
  return link;
}

export function buildBrandFaviconSvg(primary: string, glow: string, isDark: boolean): string {
  const shell = isDark ? "#0B1119" : "#111720";
  const inner = "#171C24";
  const rim = isDark ? "#26313D" : "#2C3642";

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    "<defs>",
    '<radialGradient id="glow" cx="50" cy="16" r="42" gradientUnits="userSpaceOnUse">',
    '<stop offset="0" stop-color="hsl(' + glow + ')" stop-opacity="0.24"/>',
    '<stop offset="0.52" stop-color="hsl(' + primary + ')" stop-opacity="0.08"/>',
    '<stop offset="1" stop-color="hsl(' + primary + ')" stop-opacity="0"/>',
    "</radialGradient>",
    "</defs>",
    '<rect x="4" y="4" width="56" height="56" rx="18" fill="' + shell + '"/>',
    '<rect x="5.5" y="5.5" width="53" height="53" rx="16.5" fill="' + inner + '" stroke="' + rim + '" stroke-width="1.5"/>',
    '<rect x="5.5" y="5.5" width="53" height="53" rx="16.5" fill="url(#glow)"/>',
    '<rect x="13" y="21" width="29" height="8" rx="4" fill="#F8FAFC"/>',
    '<circle cx="49" cy="25" r="4" fill="hsl(' + primary + ')"/>',
    '<rect x="17" y="40" width="31" height="5" rx="2.5" fill="hsl(' + primary + ')" opacity="0.76"/>',
    "</svg>",
  ].join("");
}

export function updateBrandFavicon(): void {
  if (typeof document === "undefined") return;

  const primary = readCssHsl("--primary", FALLBACK_PRIMARY);
  const glow = readCssHsl("--primary-glow", FALLBACK_GLOW);
  const svg = buildBrandFaviconSvg(primary, glow, document.documentElement.classList.contains("dark"));
  const link = ensureFaviconLink();
  link.href = "data:image/svg+xml," + encodeURIComponent(svg);
}
