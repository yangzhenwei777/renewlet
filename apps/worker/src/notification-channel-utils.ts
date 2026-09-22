import type { AppLocale } from "./http";
import { serverFormat } from "./server-i18n";

export function requiredSetting(value: string, label: string, locale: AppLocale): string {
  if (value.trim()) return value.trim();
  throw new Error(serverFormat(locale, "common.requiredField", { label }));
}

export function firstNonEmptyText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function notificationHttpErrorMessage(channel: string, status: number, detail: string, locale: AppLocale): string {
  return serverFormat(locale, "notification.httpSendFailed", {
    channel,
    status,
    detail: detail.trim().slice(0, 800),
  });
}
