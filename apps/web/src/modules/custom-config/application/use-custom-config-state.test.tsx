import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUSTOM_CONFIG, type ConfigItem, type CustomConfig } from "@/types/config";
import { useCustomConfigController } from "./use-custom-config-state";

const mocks = vi.hoisted(() => ({
  getCustomConfig: vi.fn(),
  saveCustomConfig: vi.fn(),
}));

vi.mock("@/services/custom-config-service", () => ({
  customConfigService: {
    get: mocks.getCustomConfig,
    save: mocks.saveCustomConfig,
  },
}));

const CUSTOM_CONFIG_QUERY_KEY = ["custom-config"] as const;

function currencyItem(value: string): ConfigItem {
  const defaultItem = DEFAULT_CUSTOM_CONFIG.currencies.find((currency) => currency.value === value);
  if (!defaultItem) throw new Error(`Missing test currency ${value}`);
  return defaultItem;
}

function customCurrencyConfig(values: readonly string[]): CustomConfig {
  const selectedValues = new Set(values);
  return {
    ...DEFAULT_CUSTOM_CONFIG,
    currencies: [
      ...values.map(currencyItem),
      ...DEFAULT_CUSTOM_CONFIG.currencies.filter((currency) => !selectedValues.has(currency.value)),
    ],
  };
}

function firstCurrencyValues(config: Pick<CustomConfig, "currencies">): string[] {
  return config.currencies.slice(0, 4).map((currency) => currency.value);
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useCustomConfigController", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.getCustomConfig.mockReset().mockResolvedValue(null);
    mocks.saveCustomConfig.mockReset().mockImplementation(async (config: CustomConfig) => config);
  });

  it("keeps provider state and custom-config query cache aligned after explicit save", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const nextConfig = customCurrencyConfig(["PHP", "AED", "CNY", "USD"]);
    const { result } = renderHook(() => useCustomConfigController(), { wrapper: createWrapper(queryClient) });

    let savedConfig: CustomConfig | null = null;
    await act(async () => {
      savedConfig = await result.current.saveConfig(nextConfig);
    });

    if (!savedConfig) throw new Error("saveConfig did not return custom config");
    expect(firstCurrencyValues(savedConfig)).toEqual(["PHP", "AED", "CNY", "USD"]);
    expect(firstCurrencyValues(result.current.config)).toEqual(["PHP", "AED", "CNY", "USD"]);
    const cachedConfig = queryClient.getQueryData<CustomConfig>(CUSTOM_CONFIG_QUERY_KEY);
    if (!cachedConfig) throw new Error("saveConfig did not update custom config query cache");
    expect(firstCurrencyValues(cachedConfig)).toEqual(["PHP", "AED", "CNY", "USD"]);
  });
});
