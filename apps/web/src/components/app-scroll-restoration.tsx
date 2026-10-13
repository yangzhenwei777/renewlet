import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router";

const MAX_SCROLL_ENTRIES = 50;

function getAppScrollRoot() {
  return typeof document === "undefined" ? null : document.getElementById("root");
}

function saveScrollPosition(positions: Map<string, number>, key: string, top: number) {
  if (positions.has(key)) positions.delete(key);
  positions.set(key, top);

  while (positions.size > MAX_SCROLL_ENTRIES) {
    const oldestKey = positions.keys().next().value;
    if (oldestKey === undefined) break;
    positions.delete(oldestKey);
  }
}

export function AppScrollRestoration() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const positionsRef = useRef(new Map<string, number>());
  const locationKeyRef = useRef(location.key);
  const locationRef = useRef({ pathname: location.pathname, search: location.search, hash: location.hash });
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!("scrollRestoration" in window.history)) return;

    const previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";

    return () => {
      window.history.scrollRestoration = previousScrollRestoration;
    };
  }, []);

  useEffect(() => {
    const root = getAppScrollRoot();
    if (!root) return;

    const saveCurrentFrame = () => {
      frameRef.current = null;
      saveScrollPosition(positionsRef.current, locationKeyRef.current, root.scrollTop);
    };

    const handleScroll = () => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(saveCurrentFrame);
    };

    root.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      root.removeEventListener("scroll", handleScroll);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, []);

  useLayoutEffect(() => {
    const root = getAppScrollRoot();
    const currentKey = location.key;
    const positions = positionsRef.current;
    const previousLocation = locationRef.current;
    const hashOnlyNavigation = previousLocation.pathname === location.pathname
      && previousLocation.search === location.search
      && previousLocation.hash !== location.hash;
    const sameDocumentLocation = previousLocation.pathname === location.pathname
      && previousLocation.search === location.search
      && previousLocation.hash === location.hash;
    locationRef.current = {
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
    };
    locationKeyRef.current = currentKey;

    if (root) {
      // hash 只是同一设置页内的锚点；保留当前 #root 位置，交给设置导航在骨架提交后定位，避免先被重置到顶部。
      if (!hashOnlyNavigation && !sameDocumentLocation) {
        // #root 是应用滚动上下文，React Router 的 window 滚动恢复覆盖不到这里。
        root.scrollTop = navigationType === "POP" ? positions.get(currentKey) ?? 0 : 0;
      }
      saveScrollPosition(positions, currentKey, root.scrollTop);
    }

    return () => {
      const latestRoot = getAppScrollRoot();
      if (latestRoot) saveScrollPosition(positions, currentKey, latestRoot.scrollTop);
    };
  }, [location.hash, location.key, location.pathname, location.search, navigationType]);

  return null;
}
