// 媒体候选 hook 测试保护搜索去重、blocked 集合和 resolver 响应合并策略。
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaCandidates } from "./use-media-candidates";

type ResolveMock = typeof import("@/services/media-candidate-service").mediaCandidateService.resolve;

const mocks = vi.hoisted(() => ({
  resolve: vi.fn<ResolveMock>(),
}));

vi.mock("@/services/media-candidate-service", () => ({
  mediaCandidateService: {
    resolve: mocks.resolve,
  },
}));

const netflixCandidate = {
  id: "builtin:thesvg:netflix:default",
  kind: "logo" as const,
  source: "builtIn" as const,
  provider: "thesvg",
  label: "Netflix",
  variant: "default",
  url: "https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/netflix/default.svg",
  confidence: "exact" as const,
  autoAssignable: true,
  matchedQuery: "netflix",
  rank: 0,
};

const faviconCandidate = {
  id: "favicon:site:netflix.com:1",
  kind: "logo" as const,
  source: "favicon" as const,
  provider: "site",
  label: "netflix.com",
  variant: null,
  url: "https://netflix.com/favicon.ico",
  confidence: "weak" as const,
  autoAssignable: false,
  matchedQuery: "netflix.com",
  rank: 1,
};

describe("useMediaCandidates", () => {
  beforeEach(() => {
    mocks.resolve.mockReset();
    mocks.resolve.mockResolvedValue({
      items: [{
        id: "search",
        autoCandidate: null,
        candidates: {
          best: netflixCandidate,
          builtIn: [netflixCandidate],
          appStore: [],
          favicon: [faviconCandidate],
        },
      }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-fills and searches with autoQuery once per open", async () => {
    const { result } = renderHook(() => useMediaCandidates({ kind: "logo", autoQuery: "Netflix", limit: 12 }));

    act(() => {
      result.current.onOpenChange(true);
    });

    await waitFor(() => {
      expect(result.current.query).toBe("Netflix");
    });
    expect(mocks.resolve).toHaveBeenCalledWith({
      kind: "logo",
      mode: "search",
      items: [{ id: "search", name: "Netflix" }],
      limit: 12,
    }, expect.any(AbortSignal));
    await waitFor(() => {
      expect(result.current.candidates.builtIn).toEqual([netflixCandidate]);
    });
  });

  it("includes the current website when resolving manual logo search candidates", async () => {
    const { result } = renderHook(() => useMediaCandidates({ kind: "logo", website: " https://www.svix.com/ " }));

    act(() => {
      result.current.onOpenChange(true);
      result.current.setQuery("Svix");
      result.current.search();
    });

    await waitFor(() => {
      expect(mocks.resolve).toHaveBeenCalledWith({
        kind: "logo",
        mode: "search",
        items: [{ id: "search", name: "Svix", website: "https://www.svix.com/" }],
        limit: 32,
      }, expect.any(AbortSignal));
    });
  });

  it("keeps an intentionally cleared autoQuery empty", async () => {
    const { result } = renderHook(() => useMediaCandidates({ kind: "logo", autoQuery: "Netflix" }));

    act(() => {
      result.current.onOpenChange(true);
    });
    await waitFor(() => {
      expect(result.current.query).toBe("Netflix");
    });

    act(() => {
      result.current.setQuery("");
      result.current.search();
    });

    expect(result.current.query).toBe("");
    expect(result.current.candidates.builtIn).toEqual([]);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });

  it("aborts active requests and delays visible reset on close", () => {
    vi.useFakeTimers();
    mocks.resolve.mockImplementation(() => new Promise(() => undefined) as ReturnType<ResolveMock>);
    const { result } = renderHook(() => useMediaCandidates({ kind: "logo", closeResetDelayMs: 200 }));

    act(() => {
      result.current.onOpenChange(true);
      result.current.setQuery("youtube");
      result.current.search();
    });

    const signal = mocks.resolve.mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);

    act(() => {
      result.current.onOpenChange(false);
    });

    expect(signal?.aborted).toBe(true);
    expect(result.current.query).toBe("youtube");

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.query).toBe("");
    expect(result.current.hasSearched).toBe(false);
  });

  it("blacklists failed image URLs from the current candidate group", async () => {
    const { result } = renderHook(() => useMediaCandidates({ kind: "logo" }));

    act(() => {
      result.current.onOpenChange(true);
      result.current.setQuery("Netflix");
      result.current.search();
    });
    await waitFor(() => {
      expect(result.current.candidates.favicon).toEqual([faviconCandidate]);
    });

    act(() => {
      result.current.removeCandidate(faviconCandidate.url);
    });

    expect(result.current.candidates.favicon).toEqual([]);
    expect(result.current.candidates.best).toEqual(netflixCandidate);
  });

  it("blacklists App Store image URLs before favicon fallback", async () => {
    const appStoreCandidate = {
      ...faviconCandidate,
      id: "appstore:us:123",
      source: "appStore" as const,
      provider: "appStore",
      label: "Netflix",
      url: "https://is1-ssl.mzstatic.com/image/thumb/netflix.png",
      confidence: "strong" as const,
      matchedQuery: "netflix",
      rank: 0,
    };
    mocks.resolve.mockResolvedValueOnce({
      items: [{
        id: "search",
        autoCandidate: null,
        candidates: {
          best: appStoreCandidate,
          builtIn: [],
          appStore: [appStoreCandidate],
          favicon: [faviconCandidate],
        },
      }],
    });
    const { result } = renderHook(() => useMediaCandidates({ kind: "logo" }));

    act(() => {
      result.current.onOpenChange(true);
      result.current.setQuery("Netflix");
      result.current.search();
    });
    await waitFor(() => {
      expect(result.current.candidates.appStore).toEqual([appStoreCandidate]);
    });

    act(() => {
      result.current.removeCandidate(appStoreCandidate.url);
    });

    expect(result.current.candidates.appStore).toEqual([]);
    expect(result.current.candidates.best).toEqual(faviconCandidate);
  });

  it("keeps failed image URLs blocked across repeated searches in the same open session", async () => {
    const { result } = renderHook(() => useMediaCandidates({ kind: "logo" }));

    act(() => {
      result.current.onOpenChange(true);
      result.current.setQuery("Netflix");
      result.current.search();
    });
    await waitFor(() => {
      expect(result.current.candidates.favicon).toEqual([faviconCandidate]);
    });

    act(() => {
      result.current.removeCandidate(faviconCandidate.url);
      result.current.search();
    });

    await waitFor(() => {
      expect(mocks.resolve).toHaveBeenCalledTimes(2);
    });
    expect(result.current.candidates.favicon).toEqual([]);
  });
});
