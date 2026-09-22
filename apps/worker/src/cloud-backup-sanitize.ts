import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";

const SECRET_SETTING_KEYS: Array<keyof ApiAppSettings> = [
  "testPhone",
  "telegramBotToken",
  "telegramChatId",
  "notifyxApiKey",
  "webhookUrl",
  "webhookHeaders",
  "webhookPayload",
  "dingtalkWebhookUrl",
  "dingtalkSecret",
  "dingtalkKeyword",
  "dingtalkTitleTemplate",
  "dingtalkContentTemplate",
  "wechatWebhookUrl",
  "wechatAtPhones",
  "smtpHost",
  "smtpPort",
  "smtpSecure",
  "smtpUser",
  "smtpPassword",
  "smtpFrom",
  "smtpReplyTo",
  "recipientEmail",
  "barkServerUrl", "barkDeviceKey", "serverchanSendKey",
  "discordWebhookUrl", "discordBotUsername", "discordBotAvatarUrl", "pushplusToken",
];

export function sanitizeSettingsForCloudBackup(settings: ApiAppSettings): Partial<ApiAppSettings> {
  const sanitized = { ...settings } as Partial<ApiAppSettings> & Record<string, unknown>;
  // 普通云快照用于恢复订阅数据，不是 secrets 备份；新增外部通知字段必须进入这组剔除边界。
  for (const key of SECRET_SETTING_KEYS) delete sanitized[key];
  if (sanitized.aiRecognition) {
    sanitized.aiRecognition = {
      ...sanitized.aiRecognition,
      baseUrl: "",
      apiKey: "",
    };
  }
  return sanitized;
}
