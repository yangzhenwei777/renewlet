import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExchangeRateSnapshot, ExchangeRateStore } from "./exchange-rate-store";
import {
  createUseExchangeRates,
  type ExchangeRateRefreshResult,
} from "./use-exchange-rates";

function snapshot(overrides: Partial<ExchangeRateSnapshot> = {}): ExchangeRateSnapshot {
  return {
    rates: { USD: 1, CNY: 7 },
    baseRate: "USD",
    activeProvider: "frankfurter",
    warning: null,
    sourceDate: "2026-08-01",
    lastUpdated: new Date("2026-08-06T00:00:00.000Z"),
    ...overrides,
  };
}

function cachedStore(loadRemoteSnapshot: ExchangeRateStore["loadRemoteSnapshot"]): ExchangeRateStore {
  return {
    readCachedSnapshot: () => snapshot(),
    loadRemoteSnapshot,
  };
}

describe("useExchangeRates manual refresh", () => {
  it("keeps ready data available while exposing refresh progress and success", async () => {
    let resolveRemote!: (value: ExchangeRateSnapshot) => void;
    const store = cachedStore(vi.fn(() => new Promise<ExchangeRateSnapshot>((resolve) => {
      resolveRemote = resolve;
    })));
    const useExchangeRates = createUseExchangeRates(store);
    const { result } = renderHook(() => useExchangeRates());

    await waitFor(() => expect(result.current.loading).toBe(false));
    let refreshPromise!: Promise<ExchangeRateRefreshResult>;
    act(() => {
      refreshPromise = result.current.refresh();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.isRefreshing).toBe(true);

    await act(async () => {
      resolveRemote(snapshot({ rates: { USD: 1, CNY: 7.2 } }));
      expect(await refreshPromise).toEqual({ status: "succeeded", warning: null });
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.isRefreshing).toBe(false);
  });

  it("returns failure after switching to built-in fallback rates", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = cachedStore(vi.fn().mockRejectedValue(new Error("network down")));
    const useExchangeRates = createUseExchangeRates(store);
    const { result } = renderHook(() => useExchangeRates());

    await waitFor(() => expect(result.current.loading).toBe(false));
    let refreshResult: ExchangeRateRefreshResult | undefined;
    await act(async () => {
      refreshResult = await result.current.refresh();
    });

    expect(refreshResult).toMatchObject({ status: "failed", error: "网络请求失败" });
    expect(result.current.activeProvider).toBe("builtin");
    expect(result.current.isRefreshing).toBe(false);
  });

  it("returns superseded when an older refresh completes after a newer request", async () => {
    const resolvers: Array<(value: ExchangeRateSnapshot) => void> = [];
    const store = cachedStore(vi.fn(() => new Promise<ExchangeRateSnapshot>((resolve) => {
      resolvers.push(resolve);
    })));
    const useExchangeRates = createUseExchangeRates(store);
    const { result } = renderHook(() => useExchangeRates());

    await waitFor(() => expect(result.current.loading).toBe(false));
    let firstRefresh!: Promise<ExchangeRateRefreshResult>;
    let secondRefresh!: Promise<ExchangeRateRefreshResult>;
    act(() => {
      firstRefresh = result.current.refresh();
      secondRefresh = result.current.refresh();
    });

    await act(async () => {
      resolvers[1]?.(snapshot({ rates: { USD: 1, CNY: 7.2 } }));
      expect(await secondRefresh).toEqual({ status: "succeeded", warning: null });
    });
    await act(async () => {
      resolvers[0]?.(snapshot({ rates: { USD: 1, CNY: 6.8 } }));
      expect(await firstRefresh).toEqual({ status: "superseded" });
    });

    expect(result.current.rates["CNY"]).toBe(7.2);
    expect(result.current.isRefreshing).toBe(false);
  });

  it("returns superseded when refresh completes after unmount", async () => {
    let resolveRemote!: (value: ExchangeRateSnapshot) => void;
    const store = cachedStore(vi.fn(() => new Promise<ExchangeRateSnapshot>((resolve) => {
      resolveRemote = resolve;
    })));
    const useExchangeRates = createUseExchangeRates(store);
    const { result, unmount } = renderHook(() => useExchangeRates());

    await waitFor(() => expect(result.current.loading).toBe(false));
    let refreshPromise!: Promise<ExchangeRateRefreshResult>;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    unmount();
    resolveRemote(snapshot());

    await expect(refreshPromise).resolves.toEqual({ status: "superseded" });
  });
});
