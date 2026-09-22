import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiToken } from "@/lib/api/schemas/public-api";
import { publicApiService } from "@/services/public-api-service";
import { useCreatePublicApiToken, useDeletePublicApiToken } from "./use-public-api-tokens";

vi.mock("@/services/public-api-service", () => ({
  publicApiService: {
    listTokens: vi.fn(),
    createToken: vi.fn(),
    deleteToken: vi.fn(),
  },
}));

const QUERY_KEY = ["public-api-tokens"] as const;

function token(overrides: Partial<ApiToken> = {}): ApiToken {
  return {
    id: "tok_telegram",
    name: "Telegram Bot",
    tokenPrefix: "rlt_telegram",
    scopes: ["read"],
    createdAt: "2026-06-20T00:00:00Z",
    lastUsedAt: null,
    ...overrides,
  };
}

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

describe("use-public-api-tokens", () => {
  afterEach(() => {
    vi.mocked(publicApiService.createToken).mockReset();
    vi.mocked(publicApiService.deleteToken).mockReset();
  });

  it("adds created token metadata to cache without storing plainToken", async () => {
    const queryClient = createQueryClient();
    const existing = token();
    const created = token({ id: "tok_shortcuts", name: "Shortcuts", tokenPrefix: "rlt_short" });
    queryClient.setQueryData<ApiToken[]>(QUERY_KEY, [existing]);
    vi.mocked(publicApiService.createToken).mockResolvedValue({
      token: created,
      plainToken: "rlt_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12",
    });

    const { result } = renderHook(() => useCreatePublicApiToken(), { wrapper: createWrapper(queryClient) });

    await act(async () => {
      await result.current.mutateAsync("Shortcuts");
    });

    expect(queryClient.getQueryData<ApiToken[]>(QUERY_KEY)).toEqual([created, existing]);
    expect(JSON.stringify(queryClient.getQueryData(QUERY_KEY))).not.toContain("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12");
  });

  it("removes deleted token from cache", async () => {
    const queryClient = createQueryClient();
    const deleted = token();
    const kept = token({ id: "tok_shortcuts", name: "Shortcuts", tokenPrefix: "rlt_short" });
    queryClient.setQueryData<ApiToken[]>(QUERY_KEY, [deleted, kept]);
    vi.mocked(publicApiService.deleteToken).mockResolvedValue(undefined);

    const { result } = renderHook(() => useDeletePublicApiToken(), { wrapper: createWrapper(queryClient) });

    await act(async () => {
      await result.current.mutateAsync(deleted.id);
    });

    expect(publicApiService.deleteToken).toHaveBeenCalledWith("tok_telegram");
    expect(queryClient.getQueryData<ApiToken[]>(QUERY_KEY)).toEqual([kept]);
  });
});
