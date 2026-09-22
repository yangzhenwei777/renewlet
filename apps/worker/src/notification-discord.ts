/**
 * Discord Webhook 发送器只接受官方 webhook URL。
 *
 * Webhook URL 含 token，错误详情只能保留脱敏后的上游响应；消息内容固定关闭 allowed_mentions。
 */
import type { NotificationEmailMessage } from "@renewlet/shared/email-template";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import type { AppLocale } from "./http";
import { isUnsafeOutboundHostLiteral } from "./outbound-url-policy";
import { serverFormat, serverText } from "./server-i18n";
import { plainNotificationMessage } from "./telegram-format";
import { requireNotificationHttpOk, sendNotificationJson } from "./notification-http";
import { requiredSetting } from "./notification-channel-utils";

const DISCORD_CONTENT_MAX_CHARS = 2000;

type DiscordWebhookPayload = {
  content: string;
  allowed_mentions: { parse: string[] };
  username?: string;
  avatar_url?: string;
};

export async function sendDiscord(settings: ApiAppSettings, message: NotificationEmailMessage, locale: AppLocale): Promise<void> {
  const rawWebhook = requiredSetting(settings.discordWebhookUrl, serverText(locale, "service.discordWebhookURL"), locale);
  const endpoint = discordWebhookEndpoint(rawWebhook, locale);
  const payload: DiscordWebhookPayload = {
    content: truncateChars(plainNotificationMessage(message), DISCORD_CONTENT_MAX_CHARS),
    // Discord 会默认解析 @everyone/用户/角色；订阅名和备注来自用户输入，必须固定禁止误 ping。
    allowed_mentions: { parse: [] },
  };
  if (settings.discordBotUsername.trim()) payload.username = settings.discordBotUsername.trim();
  if (settings.discordBotAvatarUrl.trim()) {
    const avatarUrl = publicHttpsUrl(settings.discordBotAvatarUrl);
    if (!avatarUrl) throw new Error(serverFormat(locale, "url.invalid", { label: serverText(locale, "service.discordBotAvatarURL") }));
    payload.avatar_url = avatarUrl;
  }
  const secrets = [rawWebhook, endpoint, discordWebhookToken(endpoint), payload.avatar_url ?? ""];
  const response = await sendNotificationJson(endpoint, payload, "Discord", locale, { secrets });
  await requireNotificationHttpOk(response, "Discord", locale, { secrets });
}

export function discordWebhookEndpoint(raw: string, locale: AppLocale): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(serverFormat(locale, "url.invalid", { label: serverText(locale, "service.discordWebhookURL") }));
  }
  if (url.protocol !== "https:") throw new Error(serverFormat(locale, "url.mustUseHttps", { label: serverText(locale, "service.discordWebhookURL") }));
  if (url.username || url.password || url.hostname.toLowerCase() !== "discord.com" || url.port) {
    throw new Error(serverFormat(locale, "url.invalid", { label: serverText(locale, "service.discordWebhookURL") }));
  }
  const parts = url.pathname.replace(/^\/api\/webhooks\//, "").split("/");
  if (!url.pathname.startsWith("/api/webhooks/") || parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(serverFormat(locale, "url.invalid", { label: serverText(locale, "service.discordWebhookURL") }));
  }
  url.searchParams.set("wait", "true");
  return url.toString();
}

function publicHttpsUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isUnsafeOutboundHostLiteral(hostname)) return null;
  return url.toString();
}

function discordWebhookToken(endpoint: string): string {
  try {
    const parts = new URL(endpoint).pathname.replace(/^\/api\/webhooks\//, "").split("/");
    return parts[1] ?? "";
  } catch {
    return "";
  }
}

function truncateChars(value: string, limit: number): string {
  return Array.from(value).slice(0, Math.max(0, limit)).join("");
}
