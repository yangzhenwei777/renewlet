import type { MessageKey, MessageParams } from "@/i18n/messages";
import { getDisplayErrorMessage } from "@/lib/display-error";
import {
  readAppearancePendingFromStorage,
  readSettingsAppearanceDraftFromStorage,
} from "@/lib/theme-storage";
import type { AppSettings } from "@/types/subscription";

type Translate = (key: MessageKey, params?: MessageParams) => string;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numericField(value: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number") return candidate;
  }
  return null;
}

function stringField(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}

function isPocketBaseUpdateRecord400(error: unknown): boolean {
  if (!isObjectRecord(error)) return false;

  const response = isObjectRecord(error["response"]) ? error["response"] : null;
  // PocketBase SDK/自定义 API 对错误对象包装不完全一致，因此这里从顶层和 response 双路径读取状态码。
  const status = numericField(error, ["status", "statusCode"])
    ?? (response ? numericField(response, ["status", "statusCode"]) : null);
  if (status !== 400) return false;

  const message = [
    stringField(error, ["message", "detail", "error"]),
    response ? stringField(response, ["message", "detail", "error"]) : null,
  ].filter(Boolean).join(" ").toLowerCase();

  return message.includes("failed to update record");
}

export function getExchangeRateProviderSaveErrorMessage(error: unknown, t: Translate) {
  if (isPocketBaseUpdateRecord400(error)) {
    return t("settings.exchangeRateProviderServerOutdated");
  }
  return getDisplayErrorMessage(error, t("settings.exchangeRateProviderSaveFailed"));
}

export function areJsonSnapshotsEqual(left: unknown, right: unknown): boolean {
  // settings/customConfig 都是由 schema 生成的稳定普通对象；用 JSON 快照比深比较依赖更轻量。
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeAccountRecipientEmail(accountEmail: string | null): string {
  const email = (accountEmail ?? "").trim();
  return email && email.includes("@") ? email : "";
}

export const EXTERNAL_INTEGRATION_SETTING_KEYS = new Set<keyof AppSettings>([
  "aiRecognition",
  "enabledChannels",
  "testPhone",
  "telegramBotToken",
  "telegramChatId",
  "telegramMessageFormat",
  "notifyxApiKey",
  "webhookUrl",
  "webhookMethod",
  "webhookHeaders",
  "webhookPayload",
  "dingtalkWebhookUrl",
  "dingtalkSecret",
  "dingtalkKeyword",
  "dingtalkMessageType",
  "dingtalkTitleTemplate",
  "dingtalkContentTemplate",
  "wechatWebhookUrl",
  "wechatMessageType",
  "wechatAddModeTag",
  "wechatAtPhones",
  "wechatAtAll",
  "smtpHost",
  "smtpPort",
  "smtpSecure",
  "smtpUser",
  "smtpPassword",
  "smtpFrom",
  "smtpReplyTo",
  "notifyMultipleAddresses",
  "recipientEmail",
  "barkServerUrl",
  "barkDeviceKey",
  "barkSilentPush",
  "serverchanSendKey",
  "discordWebhookUrl",
  "discordBotUsername",
  "discordBotAvatarUrl",
  "pushplusToken",
]);

export function createDraftSettingsFromRemote(
  remoteSettings: AppSettings,
  accountEmail: string | null,
  allowRecipientEmailDefault: boolean,
): AppSettings {
  const recipientEmail = remoteSettings.recipientEmail.trim()
    ? remoteSettings.recipientEmail
    : allowRecipientEmailDefault ? normalizeAccountRecipientEmail(accountEmail) : "";
  const baseSettings: AppSettings = recipientEmail && recipientEmail !== remoteSettings.recipientEmail
    ? { ...remoteSettings, recipientEmail }
    : remoteSettings;

  if (!readAppearancePendingFromStorage()) return baseSettings;
  // Settings 外观草稿用独立 pending 存储恢复；不能读取 Header 的本机主题偏好，否则全局切换会污染表单 dirty。
  const appearanceDraft = readSettingsAppearanceDraftFromStorage();
  return {
    ...baseSettings,
    themeMode: appearanceDraft.themeMode ?? baseSettings.themeMode,
    themeVariant: appearanceDraft.themeVariant ?? baseSettings.themeVariant,
    themeCustomColor: appearanceDraft.themeCustomColor ?? baseSettings.themeCustomColor,
  };
}

export function createSavedSettingsBaseline(remoteSettings: AppSettings, draftSettings: AppSettings): AppSettings {
  if (readAppearancePendingFromStorage()) return remoteSettings;
  // 账号邮箱自动补全属于初始化默认值；只有外观 pending 草稿才应在进页时保留为未保存改动。
  return draftSettings.recipientEmail !== remoteSettings.recipientEmail
    ? { ...remoteSettings, recipientEmail: draftSettings.recipientEmail }
    : remoteSettings;
}
