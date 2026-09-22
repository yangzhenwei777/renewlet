import { useEffect } from "react";
import { useSettings } from "@/hooks/use-settings";
import { hasThemeModeOverride, useTheme } from "@/lib/theme-provider";
import { applyThemeVariant } from "@/lib/theme-variant";
import {
  readAppearancePendingFromStorage,
  writeCustomThemeColorToStorage,
  writeThemeVariantToStorage,
} from "@/lib/theme-storage";

/** 登录后的远端外观同步；设置页存在未保存预览时，远端值不能覆盖当前草稿。 */
export default function PrivateAppearanceSync() {
  const { setTheme } = useTheme();
  const { data: settings } = useSettings();

  useEffect(() => {
    if (!settings || readAppearancePendingFromStorage()) return;

    if (!hasThemeModeOverride()) {
      setTheme(settings.themeMode, { localOverride: false });
    }
    applyThemeVariant(settings.themeVariant, settings.themeCustomColor);
    writeThemeVariantToStorage(settings.themeVariant);
    writeCustomThemeColorToStorage(settings.themeCustomColor);
  }, [setTheme, settings]);

  return null;
}
