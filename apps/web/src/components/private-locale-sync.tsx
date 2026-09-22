import { useEffect } from "react";
import { useSettings } from "@/hooks/use-settings";
import { useI18n } from "@/i18n/I18nProvider";

/** 登录后的明确账号偏好覆盖设备推断；auto 则重新交还给当前浏览器。 */
export default function PrivateLocaleSync() {
  const { data: settings } = useSettings();
  const { syncRemoteLocalePreference } = useI18n();

  useEffect(() => {
    if (settings?.localePreference) {
      syncRemoteLocalePreference(settings.localePreference);
    }
  }, [settings?.localePreference, syncRemoteLocalePreference]);

  return null;
}
