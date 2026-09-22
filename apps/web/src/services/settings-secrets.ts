import {
  SETTINGS_SECRET_KEYS,
  type SettingsSecretKey,
  type SettingsSecretUpdates,
} from "@/lib/api/schemas/settings";
import type { AppSettings } from "@/types/subscription";

// 浏览器永远只持有空白 secret 输入和 configured 状态；本模块只把本地草稿编码成 keep/set/clear 写入意图。
// 已保存明文不参与比较，后台 settings refetch 也不能借由这些 helper 覆盖未提交草稿。

export type SettingsSecretDrafts = Partial<Record<SettingsSecretKey, string>>;

export function topLevelSettingsSecretKey(key: keyof AppSettings): SettingsSecretKey | null {
  switch (key) {
    case "telegramBotToken":
    case "notifyxApiKey":
    case "webhookUrl":
    case "webhookHeaders":
    case "dingtalkWebhookUrl":
    case "dingtalkSecret":
    case "wechatWebhookUrl":
    case "smtpPassword":
    case "barkDeviceKey":
    case "serverchanSendKey":
    case "discordWebhookUrl":
    case "pushplusToken":
      return key;
    default:
      return null;
  }
}

export function withoutSecretKey(current: Set<SettingsSecretKey>, key: SettingsSecretKey): Set<SettingsSecretKey> {
  const next = new Set(current);
  next.delete(key);
  return next;
}

export function applySecretDraftsToSettings(settings: AppSettings, drafts: SettingsSecretDrafts): AppSettings {
  const next: AppSettings = { ...settings, aiRecognition: { ...settings.aiRecognition } };
  // UI 草稿允许暂时违反跨字段规则；这里只投影本地 secret，完整校验留给保存边界。
  for (const key of SETTINGS_SECRET_KEYS) {
    const value = drafts[key];
    if (!value) continue;
    switch (key) {
      case "telegramBotToken": next.telegramBotToken = value; break;
      case "notifyxApiKey": next.notifyxApiKey = value; break;
      case "webhookUrl": next.webhookUrl = value; break;
      case "webhookHeaders": next.webhookHeaders = value; break;
      case "dingtalkWebhookUrl": next.dingtalkWebhookUrl = value; break;
      case "dingtalkSecret": next.dingtalkSecret = value; break;
      case "wechatWebhookUrl": next.wechatWebhookUrl = value; break;
      case "smtpPassword": next.smtpPassword = value; break;
      case "barkDeviceKey": next.barkDeviceKey = value; break;
      case "serverchanSendKey": next.serverchanSendKey = value; break;
      case "discordWebhookUrl": next.discordWebhookUrl = value; break;
      case "pushplusToken": next.pushplusToken = value; break;
      case "aiRecognition.apiKey": next.aiRecognition.apiKey = value; break;
    }
  }
  return next;
}

export function settingsSecretUpdatesFromDrafts(
  drafts: SettingsSecretDrafts,
  cleared: ReadonlySet<SettingsSecretKey>,
): SettingsSecretUpdates {
  const updates: SettingsSecretUpdates = {};
  // 缺项即 keep，只有显式清除或非空草稿进入请求，避免空输入在保存其它设置时误删凭据。
  for (const key of SETTINGS_SECRET_KEYS) {
    if (cleared.has(key)) {
      updates[key] = { action: "clear" };
      continue;
    }
    const value = drafts[key];
    if (value) updates[key] = { action: "set", value };
  }
  return updates;
}
