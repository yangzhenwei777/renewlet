/**
 * Worker 通知外发 HTTP 边界。
 *
 * 这里对齐 Go 侧 notification_http.go：所有通知渠道外发都必须先经过统一超时、脱敏和 rawResponseText 处理。
 */
import type { AppLocale } from "./http";
import { NotificationChannelError } from "./notification-errors";
import { serverFormat } from "./server-i18n";
import { sendUpstreamRequest } from "./upstream-http";
import {
  createUpstreamErrorDetails,
  providerMessageFromResponse,
  upstreamErrorDetailsFromError,
  upstreamProviderResponseFromFetchResponse,
} from "./upstream-response";

export const NOTIFICATION_HTTP_TIMEOUT_MS = 10_000;

type NotificationRequestOptions = {
  secrets?: readonly string[];
  timeoutMs?: number;
};

type NotificationJsonOptions = NotificationRequestOptions & {
  headers?: HeadersInit;
};

export async function sendNotificationJson(
  url: string | URL,
  payload: unknown,
  service: string,
  locale: AppLocale,
  options: NotificationJsonOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("content-type", headers.get("content-type") ?? "application/json");
  return await sendNotificationRequest(url, { method: "POST", headers, body: JSON.stringify(payload) }, service, locale, options);
}

export async function sendNotificationRequest(
  url: string | URL,
  init: RequestInit,
  service: string,
  locale: AppLocale,
  options: NotificationRequestOptions = {},
): Promise<Response> {
  try {
    return await sendUpstreamRequest(url, init, {
      provider: service,
      secrets: options.secrets ?? [],
      timeoutMs: options.timeoutMs ?? NOTIFICATION_HTTP_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new NotificationChannelError(
      serverFormat(locale, "notification.httpRequestFailed", { service, error: message }),
      upstreamErrorDetailsFromError(error) ?? createUpstreamErrorDetails({ responseText: message }),
    );
  }
}

export async function requireNotificationHttpOk(
  response: Response,
  channel: string,
  locale: AppLocale,
  options: { secrets?: readonly string[] } = {},
): Promise<void> {
  if (!response.ok) {
    const providerResponse = await upstreamProviderResponseFromFetchResponse(response, { secrets: options.secrets ?? [] });
    const providerMessage = providerMessageFromResponse(providerResponse) ?? response.statusText;
    throw new NotificationChannelError(
      serverFormat(locale, "notification.httpSendFailed", {
        channel,
        status: response.status,
        detail: providerMessage.trim().slice(0, 800),
      }),
      createUpstreamErrorDetails({
        responseText: providerMessage,
        providerResponse,
      }),
    );
  }
  if (response.body) await response.body.cancel().catch(() => undefined);
}
