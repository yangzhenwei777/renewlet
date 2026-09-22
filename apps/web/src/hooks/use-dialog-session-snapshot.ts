import { useLayoutEffect, useState } from "react";

/**
 * 打开期间实时读取数据，关闭动画内锁住当前 owner 快照；owner 释放后立即回到空会话。
 */
export function useDialogSessionSnapshot<T>(open: boolean, ownerKey: string | null, current: T): T {
  const [lastOpenSnapshot, setLastOpenSnapshot] = useState(current);

  useLayoutEffect(() => {
    if (open || ownerKey === null) setLastOpenSnapshot(() => current);
  }, [current, open, ownerKey]);

  return open || ownerKey === null ? current : lastOpenSnapshot;
}
