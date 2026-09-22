/**
 * Server酱发送器封装 Cloudflare 通知链路中的特定第三方协议。
 *
 * SendKey 是用户账号级 secret，错误摘要必须脱敏；endpoint 只能由 SendKey 推导，不能让用户配置任意 URL。
 */
import type { NotificationEmailMessage } from "@renewlet/shared/email-template";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import type { AppLocale } from "./http";
import { firstNonEmptyText, notificationHttpErrorMessage, requiredSetting } from "./notification-channel-utils";
import { DEFAULT_SERVER_I18N_LOCALE, serverText } from "./server-i18n";
import { NotificationChannelError } from "./notification-errors";
import { sendNotificationJson } from "./notification-http";
import {
  createUpstreamErrorDetails,
  providerMessageFromResponse,
  redactUpstreamSecrets,
  upstreamProviderResponseFromBody,
  upstreamProviderResponseFromFetchResponse,
} from "./upstream-response";

type ServerChanResponse = {
  code?: unknown;
  message?: unknown;
  detail?: unknown;
};

export async function sendServerChan(settings: ApiAppSettings, message: NotificationEmailMessage, locale: AppLocale): Promise<void> {
  const sendKey = requiredSetting(settings.serverchanSendKey, serverText(locale, "service.serverchanSendKey"), locale);
  const endpoint = serverChanEndpoint(sendKey, locale);
  const response = await sendNotificationJson(endpoint, {
    title: message.title,
    desp: `${message.content}\n\n${message.timestamp}`,
  }, "ServerChan", locale, { secrets: [sendKey] });
  await requireServerChanSuccess(response, locale, sendKey, endpoint);
}

export function serverChanEndpoint(sendKey: string, locale: AppLocale = DEFAULT_SERVER_I18N_LOCALE): string {
  const trimmed = sendKey.trim();
  if (trimmed.startsWith("sctp")) {
    const match = /^sctp(\d+)t/.exec(trimmed);
    if (!match?.[1]) throw new Error(serverText(locale, "service.serverchanSendKeyInvalid"));
    // sctp SendKey 的数字子域名来自官方 Go SDK 和 Wallos 兼容实现，不允许用户配置任意 URL。
    return `https://${match[1]}.push.ft07.com/send/${encodeURIComponent(trimmed)}.send`;
  }
  return `https://sctapi.ftqq.com/${encodeURIComponent(trimmed)}.send`;
}

async function requireServerChanSuccess(response: Response, locale: AppLocale, sendKey: string, endpoint: string): Promise<void> {
  if (!response.ok) throw await serverChanHTTPError(response, locale, sendKey, endpoint);
  const providerResponse = await upstreamProviderResponseFromFetchResponse(response, { secrets: [sendKey] });
  const rawBody = providerResponse.body ?? "";
  let payload: ServerChanResponse | null = null;
  try {
    payload = JSON.parse(rawBody) as ServerChanResponse;
  } catch {
    throw serverChanBusinessError(response, rawBody, locale, sendKey);
  }
  // Server酱可能 HTTP 2xx 但业务 code 失败；历史摘要必须按 code 判断真实发送结果。
  if (payload?.code === undefined) {
    throw serverChanBusinessError(response, rawBody, locale, sendKey);
  }
  if (payload.code !== 0) {
    const detail = redactUpstreamSecrets(firstNonEmptyText(payload.message, payload.detail), [sendKey]) || serverText(locale, "service.serverchanResponseInvalid");
    throw new NotificationChannelError(
      notificationHttpErrorMessage("ServerChan", response.status, detail, locale),
      createUpstreamErrorDetails({
        responseText: detail,
        providerResponse,
      }),
    );
  }
}

async function serverChanHTTPError(response: Response, locale: AppLocale, sendKey: string, endpoint: string): Promise<NotificationChannelError> {
  const providerResponse = await upstreamProviderResponseFromFetchResponse(response, { secrets: [sendKey] });
  const parsed = parseServerChanPayload(providerResponse.body);
  const detail = redactUpstreamSecrets(firstNonEmptyText(parsed?.message, parsed?.detail), [sendKey])
    || providerMessageFromResponse(providerResponse)
    || serverText(locale, "service.serverchanResponseInvalid");
  return new NotificationChannelError(
    notificationHttpErrorMessage("ServerChan", response.status, detail, locale),
    createUpstreamErrorDetails({
      responseText: detail,
      providerResponse,
    }),
  );
}

function serverChanBusinessError(response: Response, rawBody: string, locale: AppLocale, sendKey: string): NotificationChannelError {
  const providerResponse = upstreamProviderResponseFromBody(response, rawBody, false, [sendKey]);
  const detail = providerMessageFromResponse(providerResponse) || serverText(locale, "service.serverchanResponseInvalid");
  return new NotificationChannelError(
    notificationHttpErrorMessage("ServerChan", response.status, detail, locale),
    createUpstreamErrorDetails({
      responseText: detail,
      providerResponse,
    }),
  );
}

function parseServerChanPayload(value: string | null | undefined): ServerChanResponse | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as ServerChanResponse;
  } catch {
    return null;
  }
}
