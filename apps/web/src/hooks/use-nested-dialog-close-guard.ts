import { useCallback, useEffect, useRef } from "react";

export function useNestedDialogCloseGuard(
  parentOpen: boolean,
  onParentOpenChange: (open: boolean) => void,
) {
  const nestedDialogOpenRef = useRef(false);
  const nestedDialogTransitionRef = useRef(0);

  const handleNestedDialogOpenChange = useCallback((open: boolean) => {
    const transition = nestedDialogTransitionRef.current + 1;
    nestedDialogTransitionRef.current = transition;
    if (open) {
      nestedDialogOpenRef.current = true;
      return;
    }
    // 子层关闭与 focus restore 同属一次 modal 交接；延迟到微任务后解除保护，避免父层在同栈收到误关闭请求。
    queueMicrotask(() => {
      if (nestedDialogTransitionRef.current === transition) nestedDialogOpenRef.current = false;
    });
  }, []);

  const handleParentOpenChange = useCallback((open: boolean) => {
    // Radix 嵌套 modal 切换焦点时可能触发父级关闭请求；子层结束前不能重置父表单工作流。
    if (!open && nestedDialogOpenRef.current) return;
    onParentOpenChange(open);
  }, [onParentOpenChange]);

  useEffect(() => {
    if (!parentOpen) {
      nestedDialogTransitionRef.current += 1;
      nestedDialogOpenRef.current = false;
    }
  }, [parentOpen]);

  return { handleNestedDialogOpenChange, handleParentOpenChange };
}
