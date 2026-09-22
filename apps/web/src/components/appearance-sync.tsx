/**
 * 本地外观同步（客户端）。
 *
 * 公开首屏只恢复本地主题变体；登录后的远端 settings 同步由私有路由壳负责，
 * 避免公开入口静态加载完整 settings 模型并在未认证页面发起私有请求。
 */

import { useEffect } from "react";
import { applyThemeVariant } from "@/lib/theme-variant";
import {
  readCustomThemeColorFromStorage,
  readThemeVariantFromStorage,
} from "@/lib/theme-storage";

/** 外观同步组件：放在 Providers 内即可。 */
export function AppearanceSync() {
  useEffect(() => {
    const storedVariant = readThemeVariantFromStorage();
    if (!storedVariant) return;
    const storedColor = readCustomThemeColorFromStorage();
    applyThemeVariant(storedVariant, storedColor);
  }, []);

  return null;
}
