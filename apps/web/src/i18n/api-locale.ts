/**
 * API 请求语言同步层。
 *
 * 架构位置：I18nProvider 调用这里把当前 locale 写入 PocketBase SDK 和自定义 fetch header，
 * 后端据此返回本地化错误文案。
 *
 * 注意： 这里是模块级状态；只应通过 `setApiLocale` 更新，避免 SDK 语言和 fetch header 分叉。
 */
import { getInitialLocale, type Locale } from "@/i18n/locales";
import { pb } from "@/lib/pocketbase";

let currentLocale: Locale = getInitialLocale();

pb.lang = currentLocale;
pb.beforeSend = (url, options) => {
  const headers = new Headers(options.headers);
  // 同时发标准头和产品头：标准头服务 Go/Worker locale 协商，产品头给代理/CDN 改写 Accept-Language 时兜底。
  headers.set("Accept-Language", currentLocale);
  headers.set("X-Renewlet-Locale", currentLocale);
  return { url, options: { ...options, headers: Object.fromEntries(headers.entries()) } };
};

export function getApiLocale(): Locale {
  return currentLocale;
}

/** 同步 PocketBase SDK 语言和后续 API header 的 locale。 */
export function setApiLocale(locale: Locale) {
  currentLocale = locale;
  pb.lang = locale;
}

export function getLocaleHeaders(): Record<string, string> {
  return {
    "Accept-Language": currentLocale,
    "X-Renewlet-Locale": currentLocale,
  };
}
