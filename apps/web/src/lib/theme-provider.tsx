/**
 * 轻量主题 Provider。
 *
 * 架构位置：统一管理 dark/light/system 解析和品牌 favicon 更新；设置页的“预览后保存”
 * 逻辑只调用这里，不直接操作 DOM class。Turnstile 这类第三方 iframe 也只能消费这里解析后的 light/dark。
 *
 * 状态链路：
 *   初始 theme -> resolvedTheme -> document class -> favicon
 *   setTheme/system media change -> resolvedTheme -> document class -> favicon
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { updateBrandFavicon } from "@/lib/brand-favicon";
import type { ResolvedThemeMode, ThemeMode } from "@/types/theme";

interface SetThemeOptions {
  localOverride?: boolean;
}

type ThemeContextValue = {
  theme: ThemeMode;
  resolvedTheme: ResolvedThemeMode;
  setTheme: (theme: ThemeMode, options?: SetThemeOptions) => void;
};

const STORAGE_KEY = "renewlet_theme_mode";
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";
export const THEME_MODE_OVERRIDE_STORAGE_KEY = "renewlet_theme_mode_override";
const ThemeContext = createContext<ThemeContextValue | null>(null);

interface ThemeState {
  theme: ThemeMode;
  resolvedTheme: ResolvedThemeMode;
}

function readInitialTheme(defaultTheme: ThemeMode): ThemeMode {
  if (typeof window === "undefined") return defaultTheme;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return defaultTheme;
}

function getSystemTheme(): ResolvedThemeMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia(SYSTEM_THEME_QUERY).matches ? "dark" : "light";
}

export function resolveThemeMode(theme: ThemeMode): ResolvedThemeMode {
  if (theme === "light" || theme === "dark") return theme;
  return getSystemTheme();
}

function readInitialThemeState(defaultTheme: ThemeMode): ThemeState {
  const theme = readInitialTheme(defaultTheme);
  return { theme, resolvedTheme: resolveThemeMode(theme) };
}

function applyResolvedTheme(resolvedTheme: ResolvedThemeMode) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  updateBrandFavicon();
}

export function hasThemeModeOverride(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(THEME_MODE_OVERRIDE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearThemeModeOverride(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(THEME_MODE_OVERRIDE_STORAGE_KEY);
  } catch {
    // 清理失败只影响下次远端主题是否能覆盖；当前主题仍由内存状态控制。
  }
}

function writeThemeModeOverride(): void {
  try {
    window.localStorage.setItem(THEME_MODE_OVERRIDE_STORAGE_KEY, "1");
  } catch {
    // 存储失败时保留当前内存态即可；远端同步仍能在后续会话收敛。
  }
}

export function ThemeProvider({
  children,
  defaultTheme = "dark",
}: {
  children: React.ReactNode;
  attribute?: "class";
  defaultTheme?: ThemeMode;
  enableSystem?: boolean;
}) {
  const [themeState, setThemeState] = useState<ThemeState>(() => readInitialThemeState(defaultTheme));
  const { theme, resolvedTheme } = themeState;

  useEffect(() => {
    applyResolvedTheme(resolvedTheme);
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [resolvedTheme, theme]);

  useEffect(() => {
    if (theme !== "system") return undefined;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(SYSTEM_THEME_QUERY);
    const handleChange = () => {
      const nextResolvedTheme: ResolvedThemeMode = media.matches ? "dark" : "light";
      setThemeState((current) => {
        // system 模式下媒体查询变化要更新 resolvedTheme；Turnstile widget 依赖它重建 iframe，而不是跟随浏览器 auto。
        if (current.theme !== "system" || current.resolvedTheme === nextResolvedTheme) return current;
        return { theme: current.theme, resolvedTheme: nextResolvedTheme };
      });
    };
    media.addEventListener("change", handleChange);
    handleChange();
    return () => media.removeEventListener("change", handleChange);
  }, [theme]);

  const setTheme = useCallback((nextTheme: ThemeMode, options: SetThemeOptions = {}) => {
    if (options.localOverride !== false) writeThemeModeOverride();
    setThemeState({ theme: nextTheme, resolvedTheme: resolveThemeMode(nextTheme) });
  }, []);

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [resolvedTheme, setTheme, theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider");
  return value;
}
