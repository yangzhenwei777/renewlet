// 更新任务 hook 测试只观察公开 query cache 与轮询资格，不依赖组件私有 state。
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider, type Query } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { systemService } from "@/services/system-service";
import {
  systemUpdateStatusQueryKey,
  systemVersionQueryKey,
  useSystemUpdate,
  useSystemUpdateStatus,
} from "./use-system-version";

vi.mock("@/services/system-service", () => ({
  systemService: {
    update: vi.fn(),
    updateStatus: vi.fn(),
    version: vi.fn(),
    restart: vi.fn(),
  },
}));

function operationFixture(status: "running" | "succeeded" | "failed" = "running") {
  const terminal = status !== "running";
  return {
    id: "operation-1",
    status,
    stage: status === "succeeded" ? "restart-pending" as const : "downloading" as const,
    currentVersion: "1.0.0",
    targetVersion: "1.1.0",
    startedAt: "2026-08-14T01:00:00Z",
    updatedAt: terminal ? "2026-08-14T01:00:02Z" : "2026-08-14T01:00:01Z",
    finishedAt: terminal ? "2026-08-14T01:00:02Z" : null,
    needsRestart: status === "succeeded",
    error: status === "failed" ? { code: "SYSTEM_UPDATE_FAILED", message: "更新失败" } : null,
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

describe("system update operation hooks", () => {
  beforeEach(() => {
    vi.mocked(systemService.update).mockReset();
    vi.mocked(systemService.updateStatus).mockReset();
  });

  it("polls only running tasks and stops at a terminal snapshot", async () => {
    const queryClient = createQueryClient();
    vi.mocked(systemService.updateStatus)
      .mockResolvedValueOnce({ operation: operationFixture("running") })
      .mockResolvedValueOnce({ operation: operationFixture("succeeded") });
    queryClient.setQueryData([...systemVersionQueryKey, true], { currentVersion: "1.0.0" });

    const { result } = renderHook(() => useSystemUpdateStatus(true), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.data?.operation?.status).toBe("running"));
    const query = queryClient.getQueryCache().find({ queryKey: systemUpdateStatusQueryKey });
    if (!query) throw new Error("expected update status query");
    expect(refetchIntervalFor(query)).toBe(1_000);

    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.data?.operation?.status).toBe("succeeded"));
    expect(refetchIntervalFor(query)).toBe(false);
    await waitFor(() => expect(queryClient.getQueryState([...systemVersionQueryKey, true])?.isInvalidated).toBe(true));
  });

  it("does not fetch while the dialog-owned query is disabled", () => {
    const queryClient = createQueryClient();
    vi.mocked(systemService.updateStatus).mockResolvedValue({ operation: null });
    renderHook(() => useSystemUpdateStatus(false), { wrapper: createWrapper(queryClient) });
    expect(systemService.updateStatus).not.toHaveBeenCalled();
  });

  it("stores the accepted POST snapshot in the shared status cache", async () => {
    const queryClient = createQueryClient();
    const running = { operation: operationFixture("running") };
    vi.mocked(systemService.update).mockResolvedValue(running);
    vi.mocked(systemService.updateStatus).mockResolvedValue(running);
    const { result } = renderHook(() => useSystemUpdate(), { wrapper: createWrapper(queryClient) });

    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(queryClient.getQueryData(systemUpdateStatusQueryKey)).toEqual(running);
  });
});

function refetchIntervalFor(query: Query): number | false | undefined {
  const refetchInterval = (query.options as {
    refetchInterval?: false | number | ((query: Query) => number | false | undefined);
  }).refetchInterval;
  return typeof refetchInterval === "function" ? refetchInterval(query) : refetchInterval;
}
