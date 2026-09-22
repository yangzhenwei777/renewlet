// locale 测试保护浏览器探测、显式偏好和 LocalizedLabels 读取，新增语言时这里应同步扩展。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAccountLocaleProjection,
  detectBrowserLocale,
  getInitialLocale,
  localeForPreference,
  normalizeLocale,
  readAccountLocaleProjection,
  writeAccountLocaleProjection,
} from "./locales";
import { ACCOUNT_LOCALE_PROJECTION_KEY } from "./account-locale-projection";
import { pb } from "@/lib/pocketbase";
import { setApiLocale } from "./api-locale";
import { writeProductSession } from "@/services/product-session";

let restoreNavigator: (() => void) | null = null;

function stubNavigatorLanguages(languages: string[], language = languages[0] ?? "") {
  restoreNavigator?.();
  const original = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { languages, language },
  });
  restoreNavigator = () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: original,
    });
    restoreNavigator = null;
  };
}

afterEach(() => {
  restoreNavigator?.();
  vi.restoreAllMocks();
});

describe("locales", () => {
  function signIn(userId = "user-1") {
    writeProductSession({
      type: "session",
      session: { expiresAt: "2026-12-31T00:00:00.000Z" },
      user: { id: userId, email: `${userId}@example.com`, name: userId, role: "admin", banned: false },
    });
  }

  it("normalizes supported language tags", () => {
    expect(normalizeLocale("zh")).toBe("zh-CN");
    expect(normalizeLocale("zh-Hant-HK")).toBe("zh-CN");
    expect(normalizeLocale("en-GB")).toBe("en-US");
    expect(normalizeLocale("fr-FR")).toBe("en-US");
  });

  it("detects Chinese browser locale before falling back to English", () => {
    localStorage.clear();
    stubNavigatorLanguages(["zh-Hant-HK", "en-US"], "en-US");

    expect(detectBrowserLocale()).toBe("zh-CN");
    expect(getInitialLocale()).toBe("zh-CN");
  });

  it("detects English browser locale from navigator languages", () => {
    localStorage.clear();
    stubNavigatorLanguages(["en-GB", "zh-CN"], "zh-CN");

    expect(detectBrowserLocale()).toBe("en-US");
  });

  it("falls back to English when the first browser language is not Chinese", () => {
    localStorage.clear();
    stubNavigatorLanguages(["fr-FR", "zh-CN"], "fr-FR");

    expect(detectBrowserLocale()).toBe("en-US");
    expect(getInitialLocale()).toBe("en-US");
    expect(localeForPreference("auto")).toBe("en-US");
  });

  it("ignores the retired renewlet_locale key", () => {
    localStorage.clear();
    localStorage.setItem("renewlet_locale", "zh-CN");
    stubNavigatorLanguages(["en-US"]);

    expect(readAccountLocaleProjection("user-1")).toBeNull();
    expect(getInitialLocale()).toBe("en-US");
  });

  it("uses a strict locale projection only for its matching product session", () => {
    localStorage.clear();
    signIn();
    writeAccountLocaleProjection("user-1", "zh-CN");
    stubNavigatorLanguages(["en-US"]);

    expect(readAccountLocaleProjection("user-1")).toBe("zh-CN");
    expect(readAccountLocaleProjection("user-2")).toBeNull();
    expect(getInitialLocale()).toBe("zh-CN");

    writeAccountLocaleProjection("user-1", "en-US");

    expect(JSON.parse(localStorage.getItem(ACCOUNT_LOCALE_PROJECTION_KEY) ?? "null")).toEqual({
      version: 1,
      userId: "user-1",
      locale: "en-US",
    });
    expect(localStorage.getItem("renewlet_locale")).toBeNull();
  });

  it("clears the explicit cache when returning to auto", () => {
    writeAccountLocaleProjection("user-1", "zh-CN");

    clearAccountLocaleProjection("user-1");

    expect(localStorage.getItem(ACCOUNT_LOCALE_PROJECTION_KEY)).toBeNull();
  });

  it("ignores the retired string-shaped account locale cache", () => {
    signIn();
    localStorage.setItem(ACCOUNT_LOCALE_PROJECTION_KEY, "zh-CN");
    stubNavigatorLanguages(["en-US"]);

    expect(readAccountLocaleProjection("user-1")).toBeNull();
    expect(getInitialLocale()).toBe("en-US");
  });

  it("keeps device detection usable when localStorage throws", () => {
    stubNavigatorLanguages(["zh-CN"]);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    expect(getInitialLocale()).toBe("zh-CN");
    expect(() => writeAccountLocaleProjection("user-1", "en-US")).not.toThrow();
    expect(() => clearAccountLocaleProjection()).not.toThrow();
  });
});

describe("PocketBase locale headers", () => {
  it("keeps headers as a plain object so the SDK can serialize JSON bodies", async () => {
    setApiLocale("en-US");

    const result = await pb.beforeSend?.("/api/example", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { ok: true },
    });

    expect(result?.options?.["headers"]).not.toBeInstanceOf(Headers);
    expect(result?.options?.["headers"]).toMatchObject({
      "content-type": "application/json",
      "accept-language": "en-US",
      "x-renewlet-locale": "en-US",
    });

    setApiLocale("zh-CN");
  });
});
