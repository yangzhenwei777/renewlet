import {
  buildNotificationEmail,
  type NotificationEmailMessage,
} from "@renewlet/shared/email-template";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { notificationSmtpConfig, sendSmtpEmail } from "./smtp";
import { assertSafeOutboundUrl } from "./outbound-url-policy";
import { sendServerChan } from "./notification-serverchan";
import { sendDiscord } from "./notification-discord";
import { sendPushPlus } from "./notification-pushplus";
import { sendDingTalk } from "./notification-dingtalk";
import { plainNotificationMessage, telegramNotificationMessage } from "./telegram-format";
import { NotificationChannelError } from "./notification-errors";
import {
  createUpstreamErrorDetails,
  redactUpstreamSecrets,
} from "./upstream-response";
import { requireNotificationHttpOk, sendNotificationJson, sendNotificationRequest } from "./notification-http";
import { requiredSetting } from "./notification-channel-utils";
import { serverText } from "./server-i18n";
import type { Env } from "./types";
import type { AppLocale } from "./http";
import type { Channel, SendSummary } from "./notification-jobs";

interface NotificationSenderContext {
  env: Env;
  settings: ApiAppSettings;
  message: NotificationEmailMessage;
  locale: AppLocale;
  appUrl?: string;
}

export type NotificationSender = (context: NotificationSenderContext) => Promise<void>;

// 渠道 registry 是通知发送的唯一分发边界；调度幂等、失败重试和 raw details 剥离仍留在 job 层。
export const notificationSenders = {
  telegram: sendTelegramChannel,
  notifyx: sendNotifyxChannel,
  webhook: ({ settings, message, locale }) => sendWebhook(settings, message, locale),
  dingtalk: ({ settings, message, locale }) => sendDingTalk(settings, message, locale),
  wechat: sendWeChatChannel,
  bark: sendBarkChannel,
  email: ({ env, settings, message, locale, appUrl }) => sendEmail(env, settings, message, locale, appUrl),
  serverchan: ({ settings, message, locale }) => sendServerChan(settings, message, locale),
  discord: ({ settings, message, locale }) => sendDiscord(settings, message, locale),
  pushplus: ({ settings, message, locale }) => sendPushPlus(settings, message, locale),
} satisfies Record<Channel, NotificationSender>;

// 这里是 Worker 通知渠道分发边界；真正 HTTP 外发统一收口到 notification-http，避免渠道绕过超时和脱敏策略。
export async function sendChannels(
  env: Env,
  channels: Channel[],
  settings: ApiAppSettings,
  message: NotificationEmailMessage,
  locale: AppLocale,
  appUrl?: string,
): Promise<SendSummary> {
  const summary: SendSummary = { attempted: channels, succeeded: [], failed: [] };
  for (const channel of channels) {
    try {
      // 多渠道是“尽力发送”：一个渠道失败要进入 summary，不能吞掉其它渠道的成功。
      await sendChannel(env, channel, settings, message, locale, appUrl);
      summary.succeeded.push(channel);
    } catch (error) {
      const details = error instanceof NotificationChannelError ? error.details : null;
      summary.failed.push({
        channel,
        error: error instanceof Error ? error.message : String(error),
        ...(details ? { details } : {}),
      });
    }
  }
  return summary;
}

export async function sendChannel(
  env: Env,
  channel: Channel,
  settings: ApiAppSettings,
  message: NotificationEmailMessage,
  locale: AppLocale,
  appUrl?: string,
): Promise<void> {
  const context: NotificationSenderContext = {
    env,
    settings,
    message,
    locale,
    ...(appUrl ? { appUrl } : {}),
  };
  await notificationSenders[channel](context);
}

async function sendTelegramChannel({ settings, message, locale }: NotificationSenderContext): Promise<void> {
  const token = requiredSetting(settings.telegramBotToken, serverText(locale, "service.telegramBotToken"), locale);
  const chatId = requiredSetting(settings.telegramChatId, serverText(locale, "service.telegramChatID"), locale);
  // Telegram 样式只在 sendMessage 边界生效；其它渠道继续消费纯文本，避免跨渠道模板语义互相污染。
  const telegramMessage = telegramNotificationMessage(message, settings.telegramMessageFormat);
  await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    ...telegramMessage,
    link_preview_options: { is_disabled: true },
  }, "Telegram", locale, undefined, { secrets: [token, chatId] });
}

async function sendNotifyxChannel({ settings, message, locale }: NotificationSenderContext): Promise<void> {
  const apiKey = requiredSetting(settings.notifyxApiKey, serverText(locale, "service.notifyxAPIKey"), locale);
  await postJson(`https://www.notifyx.cn/api/v1/send/${encodeURIComponent(apiKey)}`, {
    title: message.title,
    content: message.content,
    description: message.timestamp,
  }, "NotifyX", locale, undefined, { secrets: [apiKey] });
}

async function sendWeChatChannel({ settings, message, locale }: NotificationSenderContext): Promise<void> {
  const rawUrl = requiredSetting(settings.wechatWebhookUrl, serverText(locale, "service.wechatWebhookURL"), locale);
  await postJson(await safeHttpsUrl(rawUrl, locale), {
    msgtype: settings.wechatMessageType,
    [settings.wechatMessageType]: settings.wechatMessageType === "markdown"
      ? { content: plainNotificationMessage(message) }
      : {
          content: plainNotificationMessage(message),
          mentioned_mobile_list: settings.wechatAtAll ? ["@all"] : splitList(settings.wechatAtPhones),
        },
  }, "WeCom", locale, undefined, { secrets: [rawUrl] });
}

async function sendBarkChannel({ settings, message, locale }: NotificationSenderContext): Promise<void> {
  const deviceKey = requiredSetting(settings.barkDeviceKey, serverText(locale, "service.barkDeviceKey"), locale);
  const response = await sendNotificationRequest(await barkUrl(settings, message, locale), { method: "GET" }, "Bark", locale, { secrets: [deviceKey, settings.barkServerUrl] });
  await requireNotificationHttpOk(response, "Bark", locale, { secrets: [deviceKey, settings.barkServerUrl] });
}

async function sendWebhook(settings: ApiAppSettings, message: NotificationEmailMessage, locale: AppLocale): Promise<void> {
  const rawEndpoint = requiredSetting(settings.webhookUrl, serverText(locale, "service.webhookURL"), locale);
  const endpoint = await safeHttpsUrl(rawEndpoint, locale);
  const headers = parseHeaders(settings.webhookHeaders);
  const secrets = [rawEndpoint, ...headersSecrets(headers)];
  if (settings.webhookMethod === "GET") {
    // GET webhook 只能把模板字段放 query，避免对方服务忽略 body 导致测试“成功但无内容”。
    const url = new URL(endpoint);
    url.searchParams.set("title", message.title);
    url.searchParams.set("content", message.content);
    url.searchParams.set("timestamp", message.timestamp);
    const response = await sendNotificationRequest(url, { method: "GET", headers }, "Webhook", locale, { secrets });
    await requireNotificationHttpOk(response, "Webhook", locale, { secrets });
    return;
  }
  headers.set("content-type", headers.get("content-type") ?? "application/json");
  const body = renderWebhookPayloadTemplate(settings.webhookPayload, message, locale);
  const response = await sendNotificationRequest(endpoint, { method: "POST", headers, body }, "Webhook", locale, { secrets });
  await requireNotificationHttpOk(response, "Webhook", locale, { secrets });
}

async function sendEmail(env: Env, settings: ApiAppSettings, message: NotificationEmailMessage, locale: AppLocale, appUrl?: string): Promise<void> {
  let to = splitList(settings.recipientEmail);
  if (!settings.notifyMultipleAddresses && to.length > 1) to = to.slice(0, 1);
  if (to.length === 0) throw new Error(serverText(locale, "smtp.recipientEmpty"));
  const email = buildNotificationEmail(settings, message, { locale, ...(appUrl ? { appUrl } : {}) });
  const smtpConfig = notificationSmtpConfig(settings, locale);
  try {
    await sendSmtpEmail(smtpConfig, { to, subject: email.subject, text: email.text, html: email.html }, locale);
  } catch (error) {
    const message = error instanceof Error ? redactUpstreamSecrets(error.message, [smtpConfig.password, smtpConfig.username]) : serverText(locale, "smtp.deliveryFailed");
    throw new NotificationChannelError(message, createUpstreamErrorDetails({
      responseText: message,
    }));
  }
}

async function postJson(
  url: string | URL,
  payload: unknown,
  channel: string,
  locale: AppLocale,
  headers?: Record<string, string>,
  options: { secrets?: readonly string[] } = {},
): Promise<void> {
  const response = await sendNotificationJson(url, payload, channel, locale, {
    ...(headers ? { headers } : {}),
    ...(options.secrets ? { secrets: options.secrets } : {}),
  });
  await requireNotificationHttpOk(response, channel, locale, options);
}

async function safeHttpsUrl(raw: string, locale: AppLocale): Promise<string> {
  // Worker 没有 Go 的 DialContext 钩子；发送前先解析并拒绝内网/本机地址，避免用户配置的通知 URL 变成 SSRF 跳板。
  const url = await assertSafeOutboundUrl(raw, locale);
  return url.toString();
}

async function barkUrl(settings: ApiAppSettings, message: NotificationEmailMessage, locale: AppLocale): Promise<string> {
  const server = (await safeHttpsUrl(settings.barkServerUrl || "https://api.day.app", locale)).replace(/\/+$/, "");
  const key = requiredSetting(settings.barkDeviceKey, serverText(locale, "service.barkDeviceKey"), locale);
  const url = new URL(`${server}/${encodeURIComponent(key)}/${encodeURIComponent(message.title)}/${encodeURIComponent(message.content)}`);
  if (settings.barkSilentPush) url.searchParams.set("isArchive", "1");
  return url.toString();
}

function parseHeaders(value: string): Headers {
  const headers = new Headers();
  if (!value.trim()) return headers;
  // headers 是高级配置，保持 JSON 对象语义；解析失败应让测试发送显式失败。
  const parsed = JSON.parse(value) as Record<string, string>;
  for (const [key, item] of Object.entries(parsed)) headers.set(key, item);
  return headers;
}

function headersSecrets(headers: Headers): string[] {
  const out: string[] = [];
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    // 自定义 webhook header 由用户输入，名称命中敏感词时按请求侧 secret 处理，避免 provider 原样回显。
    if (name === "authorization" || name.includes("secret") || name.includes("token") || name.includes("signature") || name.includes("credential") || name.includes("api-key")) {
      out.push(value);
    }
  });
  return out;
}

export function renderWebhookPayloadTemplate(template: string, message: NotificationEmailMessage, locale: AppLocale): string {
  if (!template.trim()) return JSON.stringify({ title: message.title, content: message.content, timestamp: message.timestamp });
  let value: unknown;
  try {
    value = JSON.parse(template);
  } catch {
    throw new Error(serverText(locale, "validation.jsonParseFailed"));
  }
  // Webhook 模板必须先作为 JSON 解析，再只替换 string leaf；多行正文交给 JSON.stringify 转义。
  return JSON.stringify(renderWebhookTemplateValue(value, message));
}

function renderWebhookTemplateValue(value: unknown, message: NotificationEmailMessage): unknown {
  if (typeof value === "string") return applyTemplate(value, message);
  if (Array.isArray(value)) return value.map((item) => renderWebhookTemplateValue(item, message));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderWebhookTemplateValue(item, message)]));
  }
  return value;
}

function applyTemplate(template: string, message: NotificationEmailMessage): string {
  return template.replaceAll("{title}", message.title).replaceAll("{content}", message.content).replaceAll("{timestamp}", message.timestamp);
}

function splitList(input: string): string[] {
  return input.split(/[,\n;]/).map((item) => item.trim()).filter(Boolean);
}
