import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ThemeProvider, THEME_MODE_OVERRIDE_STORAGE_KEY, useTheme } from "./theme-provider";

const systemThemeQuery = "(prefers-color-scheme: dark)";

function wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider defaultTheme="dark">{children}</ThemeProvider>;
}

function installMatchMedia(matches: boolean) {
  let currentMatches = matches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    get matches() {
      return currentMatches;
    },
    media: systemThemeQuery,
    onchange: null,
    addEventListener: vi.fn((event: string, listener: (event: MediaQueryListEvent) => void) => {
      if (event === "change") listeners.add(listener);
    }),
    removeEventListener: vi.fn((event: string, listener: (event: MediaQueryListEvent) => void) => {
      if (event === "change") listeners.delete(listener);
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    dispatch(nextMatches: boolean) {
      currentMatches = nextMatches;
      const event = { matches: currentMatches, media: systemThemeQuery } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  } as MediaQueryList & { dispatch(nextMatches: boolean): void };

  Object.defineProperty(window, "matchMedia", {
    value: vi.fn(() => media),
    configurable: true,
  });
  return media;
}

describe("ThemeProvider local override", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    installMatchMedia(false);
  });

  it("exposes the resolved theme used by the actual document class", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    expect(result.current.theme).toBe("dark");
    expect(result.current.resolvedTheme).toBe("dark");
    expect(document.documentElement).toHaveClass("dark");
  });

  it("marks direct theme changes as a local device override", () => {
    // 用户在当前设备直接切换主题时写入 override，后续账号 settings 同步不能覆盖它。
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setTheme("light");
    });

    expect(localStorage.getItem("renewlet_theme_mode")).toBe("light");
    expect(localStorage.getItem(THEME_MODE_OVERRIDE_STORAGE_KEY)).toBe("1");
    expect(result.current.resolvedTheme).toBe("light");
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("can sync account theme without writing a local override", () => {
    // AppearanceSync 使用 localOverride=false 同步远端主题，避免把账号主题误标为设备偏好。
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setTheme("light", { localOverride: false });
    });

    expect(localStorage.getItem("renewlet_theme_mode")).toBe("light");
    expect(localStorage.getItem(THEME_MODE_OVERRIDE_STORAGE_KEY)).toBeNull();
    expect(result.current.resolvedTheme).toBe("light");
  });

  it("updates the resolved theme when the system preference changes", () => {
    localStorage.setItem("renewlet_theme_mode", "system");
    const media = installMatchMedia(false);
    const { result } = renderHook(() => useTheme(), { wrapper });

    expect(result.current.theme).toBe("system");
    expect(result.current.resolvedTheme).toBe("light");
    expect(document.documentElement).not.toHaveClass("dark");

    act(() => {
      media.dispatch(true);
    });

    expect(result.current.resolvedTheme).toBe("dark");
    expect(document.documentElement).toHaveClass("dark");

    act(() => {
      media.dispatch(false);
    });

    expect(result.current.resolvedTheme).toBe("light");
    expect(document.documentElement).not.toHaveClass("dark");
  });
});
