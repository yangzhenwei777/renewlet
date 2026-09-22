/**
 * 通知测试用例 hook。
 *
 * 架构位置：
 * - presentation 只关心“哪个渠道正在测试”和“点击测试”。
 * - 这里负责把当前尚未保存的 settings 作为临时覆盖传给服务端。
 *
 * 为什么传整份 settings：
 * - 用户常常先填写通知配置再点测试，若必须先保存会制造额外失败路径。
 * - 服务端测试接口不会持久化这份临时配置，因此不会污染数据库。
 */
import { useCallback, useState } from "react";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { toast } from "@/components/ui/sonner";
import { createRawErrorResponseDetails, type RawErrorResponseDetails } from "@/lib/raw-error-response";
import { CHANNEL_LABELS, type AppSettings, type NotificationChannel } from "@/types/subscription";
import { useI18n } from "@/i18n/I18nProvider";
import { notificationService } from "@/services/notification-service";
import type { SettingsSecretKey } from "@/lib/api/schemas/settings";
import { settingsSecretUpdatesFromDrafts, type SettingsSecretDrafts } from "@/services/settings-secrets";

export function useNotificationTest(
  settings: AppSettings,
  secretDrafts: SettingsSecretDrafts = {},
  clearedSecrets: ReadonlySet<SettingsSecretKey> = new Set(),
) {
  const { t, label } = useI18n();
  const [testingChannel, setTestingChannel] = useState<NotificationChannel | null>(null);
  const [errorDetails, setErrorDetails] = useState<RawErrorResponseDetails | null>(null);
  const [errorDetailsOpen, setErrorDetailsOpen] = useState(false);

  const testConnection = useCallback(
    async (channel: NotificationChannel) => {
      // 防止同一页面连续点击产生并发测试请求；部分渠道可能触发真实外部通知。
      if (testingChannel) return;
      setTestingChannel(channel);

      try {
        await notificationService.test(channel, settings, settingsSecretUpdatesFromDrafts(secretDrafts, clearedSecrets));
        toast.success(t("notification.testSuccessForChannel", { channel: label(CHANNEL_LABELS[channel]) }));
      } catch (e: unknown) {
        const details = createRawErrorResponseDetails(e);
        setErrorDetails(details);
        setErrorDetailsOpen(true);
        toast.error(t("notification.testFailed"), {
          description: getDisplayErrorMessage(e, t("notification.testFailedDescription")),
        });
      } finally {
        setTestingChannel(null);
      }
    },
    [clearedSecrets, label, secretDrafts, settings, t, testingChannel],
  );

  return {
    testingChannel,
    testConnection,
    errorDetails,
    errorDetailsOpen,
    setErrorDetailsOpen,
  };
}
