import { useEffect } from "react";

type AppRootScrollLockState = {
  count: number;
  overflowY: string;
  overscrollBehaviorY: string;
};

const APP_ROOT_SCROLL_LOCK_ATTRIBUTE = "data-app-scroll-locked";
const appRootScrollLocks = new Map<HTMLElement, AppRootScrollLockState>();

function getAppScrollRoot() {
  return typeof document === "undefined" ? null : document.getElementById("root");
}

function lockAppScrollRoot(root: HTMLElement) {
  const current = appRootScrollLocks.get(root);
  if (current) {
    current.count += 1;
    return;
  }

  appRootScrollLocks.set(root, {
    count: 1,
    overflowY: root.style.overflowY,
    overscrollBehaviorY: root.style.overscrollBehaviorY,
  });
  root.style.overflowY = "hidden";
  root.style.overscrollBehaviorY = "none";
  root.setAttribute(APP_ROOT_SCROLL_LOCK_ATTRIBUTE, "");
}

function unlockAppScrollRoot(root: HTMLElement) {
  const current = appRootScrollLocks.get(root);
  if (!current) return;

  current.count -= 1;
  if (current.count > 0) return;

  appRootScrollLocks.delete(root);
  root.style.overflowY = current.overflowY;
  root.style.overscrollBehaviorY = current.overscrollBehaviorY;
  root.removeAttribute(APP_ROOT_SCROLL_LOCK_ATTRIBUTE);
}

export function useAppRootScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return undefined;

    const root = getAppScrollRoot();
    if (!root) return undefined;

    // Renewlet 的页面滚动发生在 #root 上；Radix 的 body scroll lock 覆盖不到这个应用滚动根。
    lockAppScrollRoot(root);
    return () => unlockAppScrollRoot(root);
  }, [locked]);
}
