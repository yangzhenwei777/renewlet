/**
 * 延迟清理弹窗临时状态的 Hook。
 *
 * 架构位置：Radix Dialog 关闭动画和 React 状态清理存在同帧竞争；这里把“释放临时表单/
 * 上传预览/编辑草稿”的副作用统一延后，供配置项、订阅弹窗等复用。
 *
 * 状态链路：
 *   请求关闭 -> scheduleCleanup -> 动画开始 -> cleanup
 *   重新打开/取消 -> cancelCleanup
 *
 * 注意： 这里不保存业务状态，只控制清理时机；调用方仍必须决定哪些草稿可以丢弃。
 */
import { useCallback, useEffect, useRef } from "react";

const DEFAULT_DIALOG_CLEANUP_DELAY_MS = 200;

/**
 * 延迟执行弹窗临时状态清理。
 *
 * 为什么延迟：关闭动画开始前同步清空内容会造成布局闪烁，尤其是包含图片裁剪或长表单的弹窗。
 */
export function useDeferredDialogCleanup(
  cleanup: () => void,
  delayMs = DEFAULT_DIALOG_CLEANUP_DELAY_MS,
) {
  const cleanupRef = useRef(cleanup);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    cleanupRef.current = cleanup;
  }, [cleanup]);

  const cancelCleanup = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const scheduleCleanup = useCallback(() => {
    cancelCleanup();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      cleanupRef.current();
    }, delayMs);
  }, [cancelCleanup, delayMs]);

  useEffect(() => cancelCleanup, [cancelCleanup]);

  return { scheduleCleanup, cancelCleanup };
}
