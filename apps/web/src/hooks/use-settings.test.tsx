// settings hook 测试保护 React Query 写缓存策略，避免保存后 UI 等待 refetch 时闪回旧设置。
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  WEBHOOK_HEADERS_PLACEHOLDER,
  WEBHOOK_PAYLOAD_PLACEHOLDER,
  type AppSettings,
} from "@/types/subscription";
import { SETTINGS_QUERY_KEY } from "./settings-query-key";
import { normalizeSettings, useSettings, useUpdateSettings } from "./use-settings";
import { EMPTY_SETTINGS_SECRET_STATUS, type SettingsReadModel } from "@/services/settings-service";

const mocks = vi.hoisted(() => ({
  settingsGet: vi.fn<() => Promise<SettingsReadModel>>(),
  settingsUpdate: vi.fn<(current: AppSettings, patch: Partial<AppSettings>) => Promise<SettingsReadModel>>(),
}));

vi.mock("@/services/settings-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/settings-service")>();
  return {
    ...actual,
    settingsService: {
      get: mocks.settingsGet,
      update: mocks.settingsUpdate,
    },
  };
});

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
  };
}

function settingsEnvelope(overrides: Partial<AppSettings> = {}): SettingsReadModel {
  return { settings: settings(overrides), secretStatus: EMPTY_SETTINGS_SECRET_STATUS };
}

function normalizePersistedSettings(value: Record<string, unknown>): AppSettings {
  return normalizeSettings({ localePreference: "auto", ...value });
}

describe("useSettings query contract", () => {
  beforeEach(() => {
    mocks.settingsGet.mockReset();
    mocks.settingsUpdate.mockReset();
  });

  it("keeps cached settings fresh across remounts", async () => {
    const queryClient = createQueryClient();
    mocks.settingsGet.mockResolvedValue(settingsEnvelope({ defaultCurrency: "USD" }));
    const wrapper = createWrapper(queryClient);

    const first = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(first.result.current.data?.defaultCurrency).toBe("USD"));
    expect(mocks.settingsGet).toHaveBeenCalledTimes(1);

    first.unmount();
    const second = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => expect(second.result.current.data?.defaultCurrency).toBe("USD"));
    expect(mocks.settingsGet).toHaveBeenCalledTimes(1);
  });

  it("writes updated settings into the shared cache immediately", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(SETTINGS_QUERY_KEY, settingsEnvelope({ defaultCurrency: "CNY" }));
    mocks.settingsUpdate.mockResolvedValue(settingsEnvelope({ defaultCurrency: "USD" }));

    const { result } = renderHook(() => useUpdateSettings(), { wrapper: createWrapper(queryClient) });

    await act(async () => {
      await result.current.mutateAsync({ defaultCurrency: "USD" });
    });

    expect(mocks.settingsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ defaultCurrency: "CNY" }),
      { defaultCurrency: "USD" },
      {},
    );
    expect(queryClient.getQueryData<SettingsReadModel>(SETTINGS_QUERY_KEY)?.settings.defaultCurrency).toBe("USD");
  });

  it("resets subscription collections when the account timezone changes", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(SETTINGS_QUERY_KEY, settingsEnvelope({ timezone: "UTC" }));
    mocks.settingsUpdate.mockResolvedValue(settingsEnvelope({ timezone: "Asia/Shanghai" }));
    const resetQueries = vi.spyOn(queryClient, "resetQueries");
    const { result } = renderHook(() => useUpdateSettings(), { wrapper: createWrapper(queryClient) });

    await act(async () => {
      await result.current.mutateAsync({ timezone: "Asia/Shanghai" });
    });

    expect(resetQueries).toHaveBeenNthCalledWith(1, { queryKey: ["subscriptions", "collections", "page"] });
    expect(resetQueries).toHaveBeenNthCalledWith(2, { queryKey: ["subscriptions", "collections", "index"] });
  });

  it("refetches settings after explicit invalidation", async () => {
    const queryClient = createQueryClient();
    mocks.settingsGet
      .mockResolvedValueOnce(settingsEnvelope({ defaultCurrency: "CNY" }))
      .mockResolvedValueOnce(settingsEnvelope({ defaultCurrency: "USD" }));

    const { result } = renderHook(() => useSettings(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.data?.defaultCurrency).toBe("CNY"));

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    });

    await waitFor(() => expect(result.current.data?.defaultCurrency).toBe("USD"));
    expect(mocks.settingsGet).toHaveBeenCalledTimes(2);
  });
});

describe("normalizeSettings", () => {
  it("clears legacy Webhook example defaults so they stay placeholders only", () => {
    const settings = normalizePersistedSettings({
      webhookHeaders: WEBHOOK_HEADERS_PLACEHOLDER,
      webhookPayload: WEBHOOK_PAYLOAD_PLACEHOLDER,
    });

    expect(settings.webhookHeaders).toBe("");
    expect(settings.webhookPayload).toBe("");
  });

  it("defaults historical settings to Frankfurter as the exchange-rate provider", () => {
    const settings = normalizePersistedSettings({
      defaultCurrency: "USD",
    });

    expect(settings.defaultCurrency).toBe("USD");
    expect(settings.exchangeRateProvider).toBe("frankfurter");
  });

  it("fills missing global notification reminder days from defaults", () => {
    const settings = normalizePersistedSettings({
      defaultCurrency: "USD",
    });

    expect(settings.notificationReminderDays).toBe(3);
  });

  it("rejects invalid exchange-rate providers and falls back to defaults", () => {
    const settings = normalizePersistedSettings({
      exchangeRateProvider: "unknown",
    });

    expect(settings.exchangeRateProvider).toBe("frankfurter");
  });

  it("keeps Frankfurter as a supported exchange-rate provider", () => {
    const settings = normalizePersistedSettings({
      exchangeRateProvider: "frankfurter",
    });

    expect(settings.exchangeRateProvider).toBe("frankfurter");
  });

  it("fills missing built-in icon source settings from defaults", () => {
    const settings = normalizePersistedSettings({
      defaultCurrency: "USD",
      builtInIconSources: {
        thesvg: { enabled: false, variantsEnabled: false },
      },
    });

    expect(settings.defaultCurrency).toBe("USD");
    expect(settings.builtInIconSources).toEqual({
      ...DEFAULT_SETTINGS.builtInIconSources,
      thesvg: { enabled: false, variantsEnabled: false },
    });
  });

  it("fills missing online icon source settings from defaults", () => {
    const settings = normalizePersistedSettings({
      defaultCurrency: "USD",
      onlineIconSources: {
        appStore: { enabled: false },
      },
    });

    expect(settings.defaultCurrency).toBe("USD");
    expect(settings.onlineIconSources).toEqual({
      ...DEFAULT_SETTINGS.onlineIconSources,
      appStore: { enabled: false, storefronts: ["us"] },
    });
  });
});
