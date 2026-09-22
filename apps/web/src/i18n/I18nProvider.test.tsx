// Provider 测试保护语言真相源优先级：自动探测、远端 settings、本地预览和保存偏好必须各走各的边界。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { I18nProvider, useI18n } from "@/i18n/I18nProvider";
import PrivateLocaleSync from "@/components/private-locale-sync";
import { getApiLocale, setApiLocale } from "@/i18n/api-locale";
import { ACCOUNT_LOCALE_PROJECTION_KEY } from "@/i18n/account-locale-projection";
import { writeAccountLocaleProjection, type Locale, type LocalePreference } from "@/i18n/locales";
import { writeProductSession } from "@/services/product-session";

const mocks = vi.hoisted(() => ({
  settings: undefined as { localePreference: LocalePreference } | undefined,
  activateLoadedLocale: vi.fn(),
  loadLocaleCatalog: vi.fn(),
  reportClientError: vi.fn(),
}));

vi.mock("@/i18n/messages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/i18n/messages")>();
  return {
    ...actual,
    activateLoadedLocale: mocks.activateLoadedLocale,
    loadLocaleCatalog: mocks.loadLocaleCatalog,
  };
});

vi.mock("@/lib/report-client-error", () => ({
  reportClientError: mocks.reportClientError,
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ data: mocks.settings }),
}));

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

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <PrivateLocaleSync />
          {children}
        </I18nProvider>
      </QueryClientProvider>
    );
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function signIn(userId = "user-1") {
  writeProductSession({
    type: "session",
    session: { expiresAt: "2026-12-31T00:00:00.000Z" },
    user: { id: userId, email: `${userId}@example.com`, name: userId, role: "admin", banned: false },
  });
}

function storedProjection() {
  const value = localStorage.getItem(ACCOUNT_LOCALE_PROJECTION_KEY);
  return value ? JSON.parse(value) as unknown : null;
}

describe("I18nProvider locale sources", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.lang = "";
    setApiLocale("en-US");
    mocks.settings = undefined;
    mocks.activateLoadedLocale.mockReset();
    mocks.loadLocaleCatalog.mockReset().mockResolvedValue({});
    mocks.reportClientError.mockReset();
  });

  afterEach(() => {
    restoreNavigator?.();
  });

  it("uses browser detection without persisting an explicit preference", async () => {
    stubNavigatorLanguages(["zh-CN"]);

    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });

    expect(result.current.locale).toBe("zh-CN");
    await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
    expect(getApiLocale()).toBe("zh-CN");
    expect(storedProjection()).toBeNull();
  });

  it("lets remote settings override the automatic initial language", async () => {
    mocks.settings = { localePreference: "en-US" };
    stubNavigatorLanguages(["zh-CN"]);
    signIn();

    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.locale).toBe("en-US"));
    expect(document.documentElement.lang).toBe("en-US");
    expect(getApiLocale()).toBe("en-US");
    expect(storedProjection()).toEqual({ version: 1, userId: "user-1", locale: "en-US" });
  });

  it("uses the previewed interface language for requests without persisting it", async () => {
    mocks.settings = { localePreference: "en-US" };
    stubNavigatorLanguages(["en-US"]);
    signIn();

    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.locale).toBe("en-US"));

    act(() => {
      result.current.previewLocalePreference("zh-CN");
    });

    await waitFor(() => expect(result.current.locale).toBe("zh-CN"));
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(getApiLocale()).toBe("zh-CN");
    expect(storedProjection()).toEqual({ version: 1, userId: "user-1", locale: "en-US" });

    act(() => {
      result.current.commitLocalePreference("zh-CN");
    });

    await waitFor(() => expect(getApiLocale()).toBe("zh-CN"));
    expect(storedProjection()).toEqual({ version: 1, userId: "user-1", locale: "zh-CN" });
  });

  it("restores the saved account preference and its first-paint cache", async () => {
    mocks.settings = { localePreference: "en-US" };
    stubNavigatorLanguages(["en-US"]);
    signIn();

    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.locale).toBe("en-US"));

    act(() => {
      result.current.previewLocalePreference("zh-CN");
    });
    await waitFor(() => expect(result.current.locale).toBe("zh-CN"));
    act(() => {
      result.current.syncRemoteLocalePreference("en-US");
    });

    await waitFor(() => expect(result.current.locale).toBe("en-US"));
    expect(getApiLocale()).toBe("en-US");
    expect(storedProjection()).toEqual({ version: 1, userId: "user-1", locale: "en-US" });
  });

  it("returns an account to device detection when the preference becomes auto", async () => {
    signIn();
    writeAccountLocaleProjection("user-1", "en-US");
    mocks.settings = { localePreference: "auto" };
    stubNavigatorLanguages(["zh-CN"]);

    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.locale).toBe("zh-CN"));
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(getApiLocale()).toBe("zh-CN");
    expect(storedProjection()).toBeNull();
  });

  it("discards a late catalog result after a newer locale intent wins", async () => {
    stubNavigatorLanguages(["en-US"]);
    signIn();
    const zhCatalog = deferred<Record<string, never>>();
    const enCatalog = deferred<Record<string, never>>();
    mocks.loadLocaleCatalog.mockImplementation((locale: Locale) => (
      locale === "zh-CN" ? zhCatalog.promise : enCatalog.promise
    ));
    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });

    act(() => {
      result.current.previewLocalePreference("zh-CN");
      result.current.commitLocalePreference("en-US");
    });
    await act(async () => {
      enCatalog.resolve({});
      await enCatalog.promise;
    });
    expect(result.current.locale).toBe("en-US");
    expect(getApiLocale()).toBe("en-US");
    expect(storedProjection()).toEqual({ version: 1, userId: "user-1", locale: "en-US" });

    await act(async () => {
      zhCatalog.resolve({});
      await zhCatalog.promise;
    });
    expect(result.current.locale).toBe("en-US");
    expect(mocks.activateLoadedLocale).toHaveBeenCalledTimes(1);
    expect(mocks.activateLoadedLocale).toHaveBeenCalledWith("en-US", {});
  });

  it("allows an explicit retry after catalog loading fails", async () => {
    stubNavigatorLanguages(["en-US"]);
    signIn();
    mocks.loadLocaleCatalog
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce({});
    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });

    act(() => result.current.commitLocalePreference("zh-CN"));
    await waitFor(() => expect(mocks.reportClientError).toHaveBeenCalledTimes(1));
    expect(result.current.locale).toBe("en-US");

    act(() => result.current.commitLocalePreference("zh-CN"));
    await waitFor(() => expect(result.current.locale).toBe("zh-CN"));
    expect(mocks.loadLocaleCatalog).toHaveBeenCalledTimes(2);
    expect(getApiLocale()).toBe("zh-CN");
  });

  it("drops the account projection and returns to the device locale on logout", async () => {
    stubNavigatorLanguages(["zh-CN"]);
    signIn();
    writeAccountLocaleProjection("user-1", "en-US");
    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });
    expect(result.current.locale).toBe("en-US");

    act(() => writeProductSession(null));

    await waitFor(() => expect(result.current.locale).toBe("zh-CN"));
    expect(storedProjection()).toBeNull();
  });

  it("does not commit a catalog request that belongs to the previous account", async () => {
    stubNavigatorLanguages(["en-US"]);
    signIn("user-1");
    const zhCatalog = deferred<Record<string, never>>();
    mocks.loadLocaleCatalog.mockImplementation((locale: Locale) => (
      locale === "zh-CN" ? zhCatalog.promise : Promise.resolve({})
    ));
    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });

    act(() => result.current.commitLocalePreference("zh-CN"));
    act(() => signIn("user-2"));
    await act(async () => {
      zhCatalog.resolve({});
      await zhCatalog.promise;
    });

    expect(result.current.locale).toBe("en-US");
    expect(storedProjection()).toBeNull();
  });
});
