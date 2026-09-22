import { apiFetch } from "@/lib/api-client";
import {
  notificationHistoryResponseSchema,
  notificationOverviewResponseSchema,
  notificationRunResponseSchema,
  notificationsTestResponseSchema,
  type NotificationHistoryResponse,
  type NotificationHistoryStatusFilter,
  type NotificationOverviewResponse,
} from "@/lib/api/schemas/notifications";
import type { AppSettings, NotificationChannel } from "@/types/subscription";
import { toPublicAppSettings, type SettingsSecretUpdates } from "@/lib/api/schemas/settings";

const NOTIFICATION_TEST_TIMEOUT_MS = 20_000;

/** 通知服务层集中承接历史查询、临时测试发送和手动运行，所有响应都经过 Zod schema 收窄。 */
export const notificationService = {
  async overview(signal?: AbortSignal): Promise<NotificationOverviewResponse> {
    return await apiFetch("/api/app/notifications/overview", notificationOverviewResponseSchema, signal ? { signal } : undefined);
  },

  async history(status: NotificationHistoryStatusFilter, limit: number, offset: number, signal?: AbortSignal): Promise<NotificationHistoryResponse> {
    const params = new URLSearchParams({
      status,
      limit: String(limit),
      offset: String(offset),
    });
    return await apiFetch(`/api/app/notifications/history?${params.toString()}`, notificationHistoryResponseSchema, signal ? { signal } : undefined);
  },

  async test(channel: NotificationChannel, settings: AppSettings, secretUpdates: SettingsSecretUpdates = {}): Promise<void> {
    // 测试发送使用未保存的表单设置，服务端只临时合并，不污染持久 settings。
    await apiFetch("/api/app/notifications/test", notificationsTestResponseSchema, {
      method: "POST",
      body: JSON.stringify({ channel, settings: { ...toPublicAppSettings(settings), secretUpdates } }),
      timeoutMs: NOTIFICATION_TEST_TIMEOUT_MS,
    });
  },

  async run(force = false, settings?: AppSettings, secretUpdates: SettingsSecretUpdates = {}) {
    // force 用于手动“立即运行”；cron 路径仍按到期内容决定 sent/skipped。
    return await apiFetch("/api/app/notifications/run", notificationRunResponseSchema, {
      method: "POST",
      body: JSON.stringify({ force, ...(settings ? { settings: { ...toPublicAppSettings(settings), secretUpdates } } : {}) }),
    });
  },
};
