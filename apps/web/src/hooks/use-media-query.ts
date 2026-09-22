import { useEffect, useState } from "react";

function getMediaQueryMatches(query: string) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia(query).matches;
}

/**
 * 订阅 CSS media query，并在 SSR/jsdom 缺少 matchMedia 时稳定返回 false。
 *
 * effect 依赖只绑定 query：每次 query 变化都重新注册监听并清理旧 MediaQueryList，
 * 避免响应式组件在移动/桌面断点切换时保留过期 listener。
 */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => getMediaQueryMatches(query));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      setMatches(false);
      return undefined;
    }

    const mediaQueryList = window.matchMedia(query);
    const handleChange = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };

    setMatches(mediaQueryList.matches);
    mediaQueryList.addEventListener("change", handleChange);
    return () => {
      mediaQueryList.removeEventListener("change", handleChange);
    };
  }, [query]);

  return matches;
}
