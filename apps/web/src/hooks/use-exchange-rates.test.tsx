import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, type ReactNode } from "react";
import { createExchangeRateStore } from "./exchange-rate-store";
import { createUseExchangeRates } from "./use-exchange-rates";
import { SUPPORTED_EXCHANGE_RATE_CURRENCIES } from "@/lib/currency-data";

const EXCHANGE_RATE_LOG_PREFIX = "Failed to fetch exchange rates";
const CACHE_KEY_PREFIX = "exchange_rates_cache_v5";

const supportedRates = Object.fromEntries(
  SUPPORTED_EXCHANGE_RATE_CURRENCIES.map((code, index) => [
    code,
    code === "USD" ? 1 : Number((index + 1.25).toFixed(4)),
  ]),
) as Record<string, number>;

function makeExchangeApiUsdResponse(overrides: Record<string, unknown> = {}) {
  return {
    date: "2026-05-17",
    usd: {
      ...Object.fromEntries(
        Object.entries(supportedRates).map(([code, rate]) => [code.toLowerCase(), rate]),
      ),
      ...overrides,
    },
  };
}

function makeFrankfurterRatesResponse(overrides: Record<string, unknown> = {}) {
  const rowsByCode = Object.fromEntries(
    Object.entries(supportedRates)
      .filter(([code]) => code !== "USD")
      .map(([quote, rate]) => [
        quote,
        {
          date: "2026-07-30",
          base: "USD",
          quote,
          rate,
        },
      ]),
  ) as Record<string, unknown>;

  for (const [code, row] of Object.entries(overrides)) {
    const normalizedCode = code.toUpperCase();
    if (row === undefined) {
      delete rowsByCode[normalizedCode];
    } else {
      rowsByCode[normalizedCode] = row;
    }
  }

  return Object.values(rowsByCode);
}

function makeFloatRatesResponse(overrides: Record<string, unknown> = {}) {
  return {
    ...Object.fromEntries(
      Object.entries(supportedRates)
        .filter(([alphaCode]) => alphaCode !== "USD")
        .map(([alphaCode, rate]) => [
          alphaCode.toLowerCase(),
          {
            code: alphaCode,
            alphaCode,
            numericCode: "000",
            name: alphaCode,
            rate,
            date: "Fri, 15 May 2026 23:55:05 GMT",
            inverseRate: 1 / rate,
          },
        ]),
    ),
    ...overrides,
  };
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function requestPath(callIndex: number) {
  const [requestUrl] = vi.mocked(fetch).mock.calls[callIndex] ?? [];
  const url = new URL(String(requestUrl));
  return `${url.origin}${url.pathname}`;
}

function firstLogArg(args: unknown[]) {
  return typeof args[0] === "string" ? args[0] : "";
}

function isExchangeRateErrorLog(args: unknown[]) {
  if (firstLogArg(args).startsWith(EXCHANGE_RATE_LOG_PREFIX)) return true;
  const payload = args[1];
  return firstLogArg(args) === "client error"
    && typeof payload === "object"
    && payload !== null
    && "source" in payload
    && payload.source === "exchange-rates.fetch";
}

function logText(args: unknown[]) {
  return args.map((item) => {
    if (typeof item === "string") return item;
    if (item instanceof Error) return item.message;
    if (typeof item === "object" && item !== null && "error" in item && item.error instanceof Error) return item.error.message;
    return "";
  }).join(" ");
}

function logPayload(args: unknown[]) {
  return typeof args[1] === "object" && args[1] !== null ? args[1] as Record<string, unknown> : {};
}

function createExchangeRateLogCapture() {
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  const originalWarn = console.warn;
  const originalError = console.error;

  // 这些测试主动制造远端故障来覆盖降级路径；只吞掉汇率 Hook 的预期日志，其他 console 仍透出。
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    if (firstLogArg(args).startsWith(EXCHANGE_RATE_LOG_PREFIX)) {
      warnings.push(args);
      return;
    }
    originalWarn(...args);
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (isExchangeRateErrorLog(args)) {
      errors.push(args);
      return;
    }
    originalError(...args);
  });

  return {
    warnings,
    errors,
    expectWarning(message: string) {
      expect(warnings.some((args) => firstLogArg(args).includes(message))).toBe(true);
    },
    expectError(message: string) {
      expect(errors.some((args) => logText(args).includes(message))).toBe(true);
    },
    expectErrorSource(source: string) {
      expect(errors.some((args) => logPayload(args)["source"] === source)).toBe(true);
    },
  };
}

describe("useExchangeRates", () => {
  let exchangeRateLogs: ReturnType<typeof createExchangeRateLogCapture>;
  let useExchangeRates: ReturnType<typeof createUseExchangeRates>;

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
    useExchangeRates = createUseExchangeRates(createExchangeRateStore({
      fetch: globalThis.fetch.bind(globalThis) as typeof fetch,
      storage: localStorage,
      now: () => Date.now(),
    }));
    exchangeRateLogs = createExchangeRateLogCapture();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("uses a valid localStorage cache for the requested provider without calling the network", async () => {
    localStorage.setItem(`${CACHE_KEY_PREFIX}:exchange-api`, JSON.stringify({
      base: "USD",
      date: "2026-01-01",
      rates: { ...supportedRates, CNY: 7, USD: 1 },
      cachedAt: Date.now(),
      requestedProvider: "exchange-api",
      provider: "floatrates",
    }));

    const { result } = renderHook(() => useExchangeRates("exchange-api"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rates["CNY"]).toBe(7);
    expect(result.current.rates["USD"]).toBe(1);
    expect(result.current.activeProvider).toBe("floatrates");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores old cache keys and fetches current default rates", async () => {
    localStorage.setItem("exchange_rates_cache_v3", JSON.stringify({
      base: "USD",
      date: "2026-01-01",
      rates: { EUR: 0.9, CNY: 7, USD: 1 },
      cachedAt: Date.now(),
      requestedProvider: "floatrates",
      provider: "floatrates",
    }));
    vi.mocked(fetch).mockResolvedValue(jsonResponse(makeFrankfurterRatesResponse()));

    const { result } = renderHook(() => useExchangeRates());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestPath(0)).toBe("https://api.frankfurter.dev/v2/rates");
    expect(result.current.rates["CNY"]).toBe(supportedRates["CNY"]);
  });

  it("fetches Frankfurter by default and does not call other providers when it succeeds", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(makeFrankfurterRatesResponse()));

    const { result } = renderHook(() => useExchangeRates());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.warning).toBeNull();
    expect(result.current.activeProvider).toBe("frankfurter");
    expect(result.current.rates["CNY"]).toBe(supportedRates["CNY"]);
    expect(result.current.rates["USD"]).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestPath(0)).toBe("https://api.frankfurter.dev/v2/rates");

    const cached = JSON.parse(localStorage.getItem(`${CACHE_KEY_PREFIX}:frankfurter`) ?? "{}") as {
      base?: string;
      provider?: string;
      requestedProvider?: string;
      rates?: Record<string, number>;
    };
    expect(cached["base"]).toBe("USD");
    expect(cached["provider"]).toBe("frankfurter");
    expect(cached["requestedProvider"]).toBe("frankfurter");
    expect(cached["rates"]?.["CNY"]).toBe(supportedRates["CNY"]);
    expect(cached["rates"]?.["USD"]).toBe(1);
  });

  it("accepts Frankfurter USD self quotes from the v2 feed", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(makeFrankfurterRatesResponse({
      USD: {
        date: "2026-07-30",
        base: "USD",
        quote: "USD",
        rate: 1,
      },
    })));

    const { result } = renderHook(() => useExchangeRates());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.activeProvider).toBe("frankfurter");
    expect(result.current.rates["USD"]).toBe(1);
  });

  it("uses exchange-api first when selected", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(makeExchangeApiUsdResponse()));

    const { result } = renderHook(() => useExchangeRates("exchange-api"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.activeProvider).toBe("exchange-api");
    expect(result.current.rates["CNY"]).toBe(supportedRates["CNY"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestPath(0)).toBe("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json");
  });

  it("uses the exchange-api Cloudflare fallback when jsDelivr fails", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error("jsdelivr down"))
      .mockResolvedValueOnce(jsonResponse(makeExchangeApiUsdResponse()));

    const { result } = renderHook(() => useExchangeRates("exchange-api"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.activeProvider).toBe("exchange-api");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requestPath(0)).toBe("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json");
    expect(requestPath(1)).toBe("https://latest.currency-api.pages.dev/v1/currencies/usd.min.json");
    exchangeRateLogs.expectWarning("exchange-api endpoint https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json");
  });

  it("falls back to Frankfurter when exchange-api fails", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error("jsdelivr down"))
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(makeFrankfurterRatesResponse()));

    const { result } = renderHook(() => useExchangeRates("exchange-api"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.activeProvider).toBe("frankfurter");
    expect(result.current.rates["CNY"]).toBe(supportedRates["CNY"]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(requestPath(2)).toBe("https://api.frankfurter.dev/v2/rates");
    exchangeRateLogs.expectWarning("exchange-api endpoint https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json");
    exchangeRateLogs.expectWarning("exchange-api endpoint https://latest.currency-api.pages.dev/v1/currencies/usd.min.json");
    exchangeRateLogs.expectWarning("exchange rates from exchange-api");

    const cached = JSON.parse(localStorage.getItem(`${CACHE_KEY_PREFIX}:exchange-api`) ?? "{}") as {
      provider?: string;
      requestedProvider?: string;
    };
    expect(cached["provider"]).toBe("frankfurter");
    expect(cached["requestedProvider"]).toBe("exchange-api");
  });

  it("falls back to Frankfurter when FloatRates has an invalid contract", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(makeFloatRatesResponse({
        cny: { alphaCode: "EUR", rate: supportedRates["CNY"], date: "Fri, 15 May 2026 23:55:05 GMT" },
      })))
      .mockResolvedValueOnce(jsonResponse(makeFrankfurterRatesResponse()));

    const { result } = renderHook(() => useExchangeRates("floatrates"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.activeProvider).toBe("frankfurter");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requestPath(0)).toBe("https://www.floatrates.com/daily/usd.json");
    expect(requestPath(1)).toBe("https://api.frankfurter.dev/v2/rates");
  });

  it("accepts FloatRates numeric strings and stores numbers", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(makeFloatRatesResponse({
      cny: {
        alphaCode: "CNY",
        rate: String(supportedRates["CNY"]),
        date: "Fri, 15 May 2026 23:55:05 GMT",
      },
    })));

    const { result } = renderHook(() => useExchangeRates("floatrates"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.warning).toBeNull();
    expect(result.current.activeProvider).toBe("floatrates");
    expect(result.current.rates["CNY"]).toBe(supportedRates["CNY"]);

    const cached = JSON.parse(localStorage.getItem(`${CACHE_KEY_PREFIX}:floatrates`) ?? "{}") as {
      rates?: Record<string, number>;
    };
    expect(typeof cached.rates?.["CNY"]).toBe("number");
  });

  it("updates with a partial exchange-api response and fills missing currencies from Frankfurter", async () => {
    const exchangeApiResponse = makeExchangeApiUsdResponse();
    delete exchangeApiResponse.usd["syp"];
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(exchangeApiResponse))
      .mockResolvedValueOnce(jsonResponse(makeFrankfurterRatesResponse()));

    const { result } = renderHook(() => useExchangeRates("exchange-api"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.activeProvider).toBe("exchange-api");
    expect(result.current.rates["SYP"]).toBe(supportedRates["SYP"]);
    expect(result.current.warning).toMatchObject({
      kind: "partial",
      provider: "exchange-api",
      missingCurrencies: ["SYP"],
      fillSources: { SYP: "frankfurter" },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(exchangeRateLogs.errors).toHaveLength(0);
  });

  it("uses built-in rates for a small provider gap when remote fillers fail", async () => {
    const floatRatesResponse = makeFloatRatesResponse();
    delete floatRatesResponse["syp"];
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(floatRatesResponse))
      .mockRejectedValueOnce(new Error("frankfurter down"))
      .mockRejectedValueOnce(new Error("exchange-api primary down"))
      .mockRejectedValueOnce(new Error("exchange-api fallback down"));

    const { result } = renderHook(() => useExchangeRates("floatrates"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.activeProvider).toBe("floatrates");
    expect(result.current.rates["SYP"]).toBeDefined();
    expect(result.current.warning).toMatchObject({
      provider: "floatrates",
      missingCurrencies: ["SYP"],
      fillSources: { SYP: "builtin" },
    });
  });

  it.each([
    ["alphaCode/key mismatch", () => makeFloatRatesResponse({
      cny: { alphaCode: "EUR", rate: supportedRates["CNY"], date: "Fri, 15 May 2026 23:55:05 GMT" },
    })],
    ["string rate", () => makeFloatRatesResponse({
      cny: { alphaCode: "CNY", rate: "oops", date: "Fri, 15 May 2026 23:55:05 GMT" },
    })],
    ["non-positive rate", () => makeFloatRatesResponse({
      cny: { alphaCode: "CNY", rate: 0, date: "Fri, 15 May 2026 23:55:05 GMT" },
    })],
  ])("reports contract errors when FloatRates has %s and exchange-api also fails", async (_caseName, makePayload) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(makePayload()))
      .mockRejectedValueOnce(new Error("frankfurter down"))
      .mockRejectedValueOnce(new Error("exchange-api primary down"))
      .mockRejectedValueOnce(new Error("exchange-api fallback down"));

    const { result } = renderHook(() => useExchangeRates("floatrates"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("汇率响应格式异常");
    expect(result.current.activeProvider).toBe("builtin");
    expect(result.current.rates["USD"]).toBe(1);
  });

  it("rejects providers that miss more than the partial coverage limit", async () => {
    const response = makeFloatRatesResponse();
    for (const currency of ["AED", "AFN", "ALL", "AMD", "AOA", "ARS"]) {
      delete response[currency.toLowerCase()];
    }
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(response))
      .mockRejectedValueOnce(new Error("frankfurter down"))
      .mockRejectedValueOnce(new Error("exchange-api primary down"))
      .mockRejectedValueOnce(new Error("exchange-api fallback down"));

    const { result } = renderHook(() => useExchangeRates("floatrates"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("汇率响应格式异常");
    expect(result.current.activeProvider).toBe("builtin");
  });

  it.each([
    ["string rate", () => makeExchangeApiUsdResponse({ cny: "oops" })],
    ["non-positive rate", () => makeExchangeApiUsdResponse({ cny: 0 })],
  ])("reports contract errors when exchange-api has %s and FloatRates also fails", async (_caseName, makePayload) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(makePayload()))
      .mockRejectedValueOnce(new Error("exchange-api fallback down"))
      .mockRejectedValueOnce(new Error("frankfurter down"))
      .mockRejectedValueOnce(new Error("floatrates down"));

    const { result } = renderHook(() => useExchangeRates("exchange-api"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("汇率响应格式异常");
    expect(result.current.activeProvider).toBe("builtin");
    expect(result.current.rates["USD"]).toBe(1);
  });

  it("falls back to Frankfurter for exchange-api HTTP failures", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(makeFrankfurterRatesResponse()));

    const { result } = renderHook(() => useExchangeRates("exchange-api"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.activeProvider).toBe("frankfurter");
    expect(result.current.rates["USD"]).toBe(1);
  });

  it("keeps raw response text for exchange-rate HTTP failures", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("<html>rate limited</html>", { status: 429, statusText: "Too Many Requests" }))
      .mockRejectedValueOnce(new Error("frankfurter down"))
      .mockRejectedValueOnce(new Error("exchange-api primary down"))
      .mockRejectedValueOnce(new Error("exchange-api fallback down"));

    const { result } = renderHook(() => useExchangeRates("floatrates"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("网络请求失败");
    expect(result.current.activeProvider).toBe("builtin");
    expect(result.current.errorDetails).toMatchObject({
      message: "Too Many Requests",
      responseText: "<html>rate limited</html>",
    });
  });

  it("falls back to Frankfurter when both exchange-api endpoints time out", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch)
      .mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }))
      .mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }))
      .mockResolvedValueOnce(jsonResponse(makeFrankfurterRatesResponse()));

    const { result } = renderHook(() => useExchangeRates("exchange-api"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.activeProvider).toBe("frankfurter");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("falls back with the timeout message when all remote requests time out", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = (init as RequestInit | undefined)?.signal;
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));

    const { result } = renderHook(() => useExchangeRates());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe("请求超时，请稍后重试");
    expect(result.current.activeProvider).toBe("builtin");
    expect(result.current.rates["USD"]).toBe(1);
    expect(result.current.errorDetails?.responseText).toBe("Exchange rate request timed out");
    exchangeRateLogs.expectWarning("exchange rates from frankfurter");
    exchangeRateLogs.expectWarning("exchange rates from floatrates");
    exchangeRateLogs.expectWarning("exchange rates from exchange-api");
    exchangeRateLogs.expectErrorSource("exchange-rates.fetch");
  });

  it("refresh skips cache and can use the new requested provider immediately", async () => {
    localStorage.setItem(`${CACHE_KEY_PREFIX}:exchange-api`, JSON.stringify({
      base: "USD",
      date: "2026-01-01",
      rates: { ...supportedRates, EUR: 0.9, CNY: 7, USD: 1 },
      cachedAt: Date.now(),
      requestedProvider: "exchange-api",
      provider: "exchange-api",
    }));
    vi.mocked(fetch).mockResolvedValue(jsonResponse(makeFloatRatesResponse()));

    const { result } = renderHook(() => useExchangeRates("exchange-api"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetch).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.refresh("floatrates");
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestPath(0)).toBe("https://www.floatrates.com/daily/usd.json");
    expect(result.current.activeProvider).toBe("floatrates");

    const cached = JSON.parse(localStorage.getItem(`${CACHE_KEY_PREFIX}:floatrates`) ?? "{}") as {
      provider?: string;
      requestedProvider?: string;
    };
    expect(cached["provider"]).toBe("floatrates");
    expect(cached["requestedProvider"]).toBe("floatrates");
  });

  it("reuses an in-flight request for the same requested provider", async () => {
    let signal: AbortSignal | undefined;
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation((_input, init) => new Promise<Response>((resolve, reject) => {
      signal = (init as RequestInit).signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      resolveFetch = resolve;
    }));

    const { result } = renderHook(() => useExchangeRates("floatrates"));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      const refreshPromise = result.current.refresh("floatrates");
      await Promise.resolve();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(signal?.aborted).toBe(false);
      resolveFetch?.(jsonResponse(makeFloatRatesResponse()));
      await refreshPromise;
    });

    expect(result.current.error).toBeNull();
    expect(result.current.activeProvider).toBe("floatrates");
    expect(result.current.rates["USD"]).toBe(1);
  });

  it("shares one in-flight request across hook instances for the same requested provider", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));

    const first = renderHook(() => useExchangeRates("floatrates"));
    const second = renderHook(() => useExchangeRates("floatrates"));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveFetch?.(jsonResponse(makeFloatRatesResponse()));
    });

    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(first.result.current.activeProvider).toBe("floatrates");
    expect(second.result.current.activeProvider).toBe("floatrates");
  });

  it("does not abort shared in-flight requests when one hook switches provider", async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(response: Response) => void> = [];
    vi.mocked(fetch).mockImplementation((_input, init) => new Promise<Response>((resolve, reject) => {
      const signal = (init as RequestInit).signal;
      if (signal) {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }
      resolvers.push(resolve);
    }));

    const { result } = renderHook(() => useExchangeRates("exchange-api"));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      void result.current.refresh("floatrates");
      await Promise.resolve();
    });

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(false);
    expect(signals[1]?.aborted).toBe(false);

    await act(async () => {
      resolvers[1]?.(jsonResponse(makeFloatRatesResponse()));
    });
    await waitFor(() => expect(result.current.activeProvider).toBe("floatrates"));

    await act(async () => {
      resolvers[0]?.(jsonResponse(makeExchangeApiUsdResponse()));
      await Promise.resolve();
    });
    expect(result.current.activeProvider).toBe("floatrates");
  });

  it("does not start a request for the fake StrictMode mount", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(makeFloatRatesResponse()));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );

    const { result } = renderHook(() => useExchangeRates("floatrates"), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestPath(0)).toBe("https://www.floatrates.com/daily/usd.json");
  });

  it("keeps shared in-flight requests alive on unmount", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      signal = (init as RequestInit).signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));

    const { unmount } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(signal?.aborted).toBe(false);

    unmount();
    expect(signal?.aborted).toBe(false);
  });
});
