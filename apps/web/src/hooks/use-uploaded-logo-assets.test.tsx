// 已上传 Logo 列表测试保护产品 API 分页去重和过期请求忽略，避免关闭 sheet 后旧响应复活列表状态。
import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUploadedLogoAssets } from "./use-uploaded-logo-assets";

type AssetRecordFixture = {
  id: string;
  url?: string;
  kind?: "logo";
  originalName?: string;
  mimeType?: string;
  sizeBytes?: number;
  created?: string;
  updated?: string;
};

type AssetsListFixture = {
  page: number;
  totalPages: number;
  items: AssetRecordFixture[];
};

type ApiFetchMock = (
  url: string,
  schema: unknown,
  init?: RequestInit,
) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn<ApiFetchMock>(),
  getCurrentUserId: vi.fn(() => "user_1"),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: mocks.apiFetch,
}));

vi.mock("@/lib/pocketbase", () => ({
  pb: {
    lang: "zh-CN",
    beforeSend: undefined,
  },
  getCurrentUserId: mocks.getCurrentUserId,
}));

function listResult(overrides: Partial<AssetsListFixture> = {}): AssetsListFixture {
  return {
    page: 1,
    totalPages: 1,
    items: [
      {
        id: "asset-1",
        url: "/api/app/assets/asset-1",
        kind: "logo",
        originalName: "netflix.png",
        mimeType: "image/png",
        sizeBytes: 1024,
        created: "2026-05-16T10:00:00.000Z",
        updated: "2026-05-17T10:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function createWrapper(strict = false) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    const content = <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    return strict ? <StrictMode>{content}</StrictMode> : content;
  }
  return Wrapper;
}

describe("useUploadedLogoAssets", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.getCurrentUserId.mockReturnValue("user_1");
  });

  it("loads logo assets through the product API list endpoint", async () => {
    mocks.apiFetch.mockResolvedValueOnce(listResult());
    const { result } = renderHook(() => useUploadedLogoAssets(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.loadInitial();
    });

    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    const call = mocks.apiFetch.mock.calls[0];
    if (!call) throw new Error("Expected the asset list request");
    expect(call[0]).toBe("/api/app/assets?kind=logo&page=1&perPage=48");
    expect(call[2]?.signal).toBeInstanceOf(AbortSignal);
    expect(result.current.assets).toEqual([
      {
        id: "asset-1",
        url: "/api/app/assets/asset-1",
        kind: "logo",
        originalName: "netflix.png",
        mimeType: "image/png",
        sizeBytes: 1024,
        created: "2026-05-16T10:00:00.000Z",
        updated: "2026-05-17T10:00:00.000Z",
      },
    ]);
    expect("file" in result.current.assets[0]!).toBe(false);
  });

  it("settles a successful load after the StrictMode setup-cleanup check", async () => {
    mocks.apiFetch.mockResolvedValueOnce(listResult());
    const { result } = renderHook(() => useUploadedLogoAssets(), { wrapper: createWrapper(true) });

    await act(async () => {
      await result.current.loadInitial();
    });

    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.assets.map((asset) => asset.id)).toEqual(["asset-1"]);
  });

  it("appends later pages while avoiding duplicate asset ids", async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(listResult({
        page: 1,
        totalPages: 2,
        items: [{ id: "asset-1", url: "/api/app/assets/asset-1", kind: "logo", originalName: "first.png" }],
      }))
      .mockResolvedValueOnce(listResult({
        page: 2,
        totalPages: 2,
        items: [
          { id: "asset-1", url: "/api/app/assets/asset-1", kind: "logo", originalName: "first-duplicate.png" },
          { id: "asset-2", url: "/api/app/assets/asset-2", kind: "logo", originalName: "second.svg" },
        ],
      }));
    const { result } = renderHook(() => useUploadedLogoAssets(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.loadInitial();
    });
    await waitFor(() => expect(result.current.assets.map((asset) => asset.id)).toEqual(["asset-1"]));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(mocks.apiFetch.mock.calls[1]?.[0]).toBe("/api/app/assets?kind=logo&page=2&perPage=48");
    await waitFor(() => expect(result.current.assets.map((asset) => asset.id)).toEqual(["asset-1", "asset-2"]));
  });

  it("exposes load errors and can retry the first page", async () => {
    mocks.apiFetch
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(listResult({ items: [{ id: "asset-retry", url: "/api/app/assets/asset-retry", kind: "logo" }] }));
    const { result } = renderHook(() => useUploadedLogoAssets(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.loadInitial();
    });

    await waitFor(() => expect(result.current.error?.message).toBe("offline"));
    expect(result.current.hasLoaded).toBe(false);
    expect(result.current.assets).toEqual([]);

    await act(async () => {
      await result.current.loadInitial();
    });

    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.error).toBeNull();
    expect(result.current.assets).toEqual([
      {
        id: "asset-retry",
        url: "/api/app/assets/asset-retry",
        kind: "logo",
        originalName: undefined,
        mimeType: undefined,
        sizeBytes: undefined,
        created: undefined,
        updated: undefined,
      },
    ]);
  });
});
