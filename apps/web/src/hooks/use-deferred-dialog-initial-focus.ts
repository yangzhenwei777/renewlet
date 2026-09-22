import { useLayoutEffect, useRef } from "react";

/**
 * loading shell 先建立焦点域；真实控件到达后，每个 open session/focusKey 只恢复一次原始首焦点。
 */
export function useDeferredDialogInitialFocus(
  open: boolean,
  ready: boolean,
  focusKey: string | number,
  resolveTarget: () => HTMLElement | null,
): void {
  const focusedKeyRef = useRef<string | number | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      focusedKeyRef.current = null;
      return;
    }
    if (!ready || focusedKeyRef.current === focusKey) return;
    const target = resolveTarget();
    if (!target) return;
    focusedKeyRef.current = focusKey;
    target.focus();
  }, [focusKey, open, ready, resolveTarget]);
}
