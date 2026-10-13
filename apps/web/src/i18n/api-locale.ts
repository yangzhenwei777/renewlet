// 请求语言由I18nProvider原子提交；每个传输适配器在发送时读取，不能为同步语言而初始化SDK。
import { getInitialLocale, type Locale } from "@/i18n/locales";

let currentLocale: Locale = getInitialLocale();

export function getApiLocale(): Locale {
  return currentLocale;
}

export function setApiLocale(locale: Locale) {
  currentLocale = locale;
}

export function getLocaleHeaders(): Record<string, string> {
  return {
    "Accept-Language": currentLocale,
    "X-Renewlet-Locale": currentLocale,
  };
}
