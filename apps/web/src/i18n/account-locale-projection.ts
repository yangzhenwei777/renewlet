import { isLocale, type Locale } from "@renewlet/shared/i18n-config";

export const ACCOUNT_LOCALE_PROJECTION_KEY = "renewlet_locale_preference";
const ACCOUNT_LOCALE_PROJECTION_VERSION = 1;

interface AccountLocaleProjection {
  version: typeof ACCOUNT_LOCALE_PROJECTION_VERSION;
  userId: string;
  locale: Locale;
}

function parseAccountLocaleProjection(value: string | null): AccountLocaleProjection | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3
      || record["version"] !== ACCOUNT_LOCALE_PROJECTION_VERSION
      || typeof record["userId"] !== "string"
      || record["userId"].length === 0
      || !isLocale(record["locale"])
    ) {
      return null;
    }
    return {
      version: ACCOUNT_LOCALE_PROJECTION_VERSION,
      userId: record["userId"],
      locale: record["locale"],
    };
  } catch {
    return null;
  }
}

/** 账号语言只是首屏投影，必须同时匹配当前产品 session，不能成为独立登录态或跨账号真相源。 */
export function readAccountLocaleProjection(userId: string | null): Locale | null {
  if (!userId || typeof localStorage === "undefined") return null;
  try {
    const projection = parseAccountLocaleProjection(localStorage.getItem(ACCOUNT_LOCALE_PROJECTION_KEY));
    return projection?.userId === userId ? projection.locale : null;
  } catch {
    return null;
  }
}

export function writeAccountLocaleProjection(userId: string, locale: Locale): void {
  if (!userId || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(ACCOUNT_LOCALE_PROJECTION_KEY, JSON.stringify({
      version: ACCOUNT_LOCALE_PROJECTION_VERSION,
      userId,
      locale,
    } satisfies AccountLocaleProjection));
  } catch {
    // 投影写入失败不影响已加载 catalog；远端 settings 仍是账号偏好的唯一真相源。
  }
}

export function clearAccountLocaleProjection(userId?: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (userId) {
      const projection = parseAccountLocaleProjection(localStorage.getItem(ACCOUNT_LOCALE_PROJECTION_KEY));
      if (projection && projection.userId !== userId) return;
    }
    localStorage.removeItem(ACCOUNT_LOCALE_PROJECTION_KEY);
  } catch {
    // localStorage 不可用时，Provider 仍会按当前 session 和设备语言维护内存状态。
  }
}
