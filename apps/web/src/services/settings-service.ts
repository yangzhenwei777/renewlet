import { apiFetch } from "@/lib/api-client";
import {
  appSettingsSecretStatus,
  settingsResponseSchema,
  type ApiAppSettings,
  type PublicAppSettings,
  type SettingsSecretStatus,
  type SettingsSecretUpdates,
  toEditableAppSettings,
  toPublicAppSettings,
} from "@/lib/api/schemas/settings";
import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import { getSystemTimeZone } from "@/lib/time/time-zone";
import { getCurrentUserId } from "@/lib/pocketbase";
import { normalizeSettingsValue } from "@renewlet/shared/settings-normalization";
import {
  DEFAULT_SETTINGS,
  WEBHOOK_HEADERS_PLACEHOLDER,
  WEBHOOK_PAYLOAD_PLACEHOLDER,
  type AppSettings,
} from "@/types/subscription";

function clearLegacyWebhookExample(value: string, legacyExample: string) {
  return value.trim() === legacyExample ? "" : value;
}

/**
 * 将远端 settings JSON 收敛为前端完整设置。
 *
 * 该函数只接受排他迁移后的持久化契约；不要在页面里绕过它直接消费远端值或兼容旧 locale 字段。
 */
export function normalizeSettings(value: unknown): AppSettings {
  const defaults = { ...DEFAULT_SETTINGS, timezone: getSystemTimeZone("UTC") };
  const settings = normalizeSettingsValue(value, defaults);
  return {
    ...settings,
    webhookHeaders: clearLegacyWebhookExample(settings.webhookHeaders, WEBHOOK_HEADERS_PLACEHOLDER),
    webhookPayload: clearLegacyWebhookExample(settings.webhookPayload, WEBHOOK_PAYLOAD_PLACEHOLDER),
  };
}

export interface SettingsReadModel {
  settings: AppSettings;
  secretStatus: SettingsSecretStatus;
}

export const EMPTY_SETTINGS_SECRET_STATUS = appSettingsSecretStatus(DEFAULT_SETTINGS);

function editableSettingsFromPublicView(settings: PublicAppSettings): AppSettings {
  const editable = toEditableAppSettings(settings);
  return {
    ...editable,
    webhookPayload: clearLegacyWebhookExample(editable.webhookPayload, WEBHOOK_PAYLOAD_PLACEHOLDER),
  };
}

/** 设置服务统一调用 Renewlet 产品 API；Docker 端也不能回退到 PocketBase collection REST。 */
export const settingsService = {
  async get(signal?: AbortSignal): Promise<SettingsReadModel> {
    const userId = getCurrentUserId();
    if (!userId) return { settings: DEFAULT_SETTINGS, secretStatus: EMPTY_SETTINGS_SECRET_STATUS };
    const data = await apiFetch("/api/app/settings", settingsResponseSchema, signal ? { signal } : undefined);
    return { settings: editableSettingsFromPublicView(data.settings), secretStatus: data.secretStatus };
  },

  async update(
    current: AppSettings,
    patch: Partial<AppSettings>,
    secretUpdates: SettingsSecretUpdates = {},
  ): Promise<SettingsReadModel> {
    const userId = getCurrentUserId();
    if (!userId) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
    const next = normalizeSettings({ ...current, ...patch });
    // 浏览器只发送公开 settings 与判别式 secret mutation；任何 draft secret 都不会混入普通字段。
    const data = await apiFetch("/api/app/settings", settingsResponseSchema, {
      method: "PUT",
      body: JSON.stringify({ ...toPublicAppSettings(next satisfies ApiAppSettings), secretUpdates }),
    });
    return { settings: editableSettingsFromPublicView(data.settings), secretStatus: data.secretStatus };
  },
};
