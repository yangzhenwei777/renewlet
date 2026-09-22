// 内置图标索引刷新是后台 Queue 状态；前端轮询只能跟随 queued/running job，终态必须停止。
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider, type Query } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltInIconIndexStatus, BuiltInIconRefreshJobStatus } from "@/lib/api/schemas/media";
import { builtInIconIndexService } from "@/services/built-in-icon-index-service";
import {
  builtInIconIndexQueryKey,
  useBuiltInIconIndexStatus,
  useRefreshBuiltInIconIndexProvider,
} from "./use-built-in-icon-index";

vi.mock("@/services/built-in-icon-index-service", () => ({
  builtInIconIndexService: {
    status: vi.fn(),
    check: vi.fn(),
    refresh: vi.fn(),
  },
}));

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

function statusFixture(jobStatus: BuiltInIconRefreshJobStatus | null): BuiltInIconIndexStatus {
  const job = jobStatus ? {
    id: `job_${jobStatus}`,
    provider: "thesvg" as const,
    status: jobStatus,
    queuedAt: "2026-06-11T00:00:00Z",
    startedAt: jobStatus === "queued" ? null : "2026-06-11T00:00:01Z",
    finishedAt: jobStatus === "queued" || jobStatus === "running" ? null : "2026-06-11T00:00:02Z",
    attempts: jobStatus === "queued" ? 0 : 1,
    error: jobStatus === "failed" ? "checksum mismatch" : null,
    indexHash: jobStatus === "succeeded" ? "a".repeat(64) : null,
  } : null;

  return {
    source: "embedded",
    hash: "embedded-hash",
    iconCount: 3,
    providerCounts: { thesvg: 1, selfhst: 1, dashboardIcons: 1 },
    checkedAt: null,
    updatedAt: null,
    refreshing: jobStatus === "queued" || jobStatus === "running",
    providers: ["thesvg", "selfhst", "dashboardIcons"].map((provider) => ({
      provider: provider as "thesvg" | "selfhst" | "dashboardIcons",
      current: null,
      latest: null,
      iconCount: 1,
      checkedAt: null,
      refreshedAt: null,
      lastError: null,
      refreshing: provider === "thesvg" && (jobStatus === "queued" || jobStatus === "running"),
      updateAvailable: false,
      ...(provider === "thesvg" && job ? { job } : {}),
    })),
  };
}

describe("useBuiltInIconIndexStatus", () => {
  beforeEach(() => {
    vi.mocked(builtInIconIndexService.status).mockReset();
    vi.mocked(builtInIconIndexService.refresh).mockReset();
  });

  it("polls queued or running refresh jobs and stops on failed jobs", async () => {
    const queuedClient = createQueryClient();
    vi.mocked(builtInIconIndexService.status).mockResolvedValueOnce(statusFixture("queued"));
    renderHook(() => useBuiltInIconIndexStatus(true), { wrapper: createWrapper(queuedClient) });
    await waitFor(() => expect(queuedClient.getQueryData(builtInIconIndexQueryKey)).toMatchObject({ refreshing: true }));

    const queuedQuery = queuedClient.getQueryCache().find({ queryKey: builtInIconIndexQueryKey });
    if (!queuedQuery) throw new Error("expected queued status query");
    expect(refetchIntervalFor(queuedQuery)).toBe(3000);

    const failedClient = createQueryClient();
    vi.mocked(builtInIconIndexService.status).mockResolvedValueOnce(statusFixture("failed"));
    renderHook(() => useBuiltInIconIndexStatus(true), { wrapper: createWrapper(failedClient) });
    await waitFor(() => expect(failedClient.getQueryData(builtInIconIndexQueryKey)).toMatchObject({ refreshing: false }));

    const failedQuery = failedClient.getQueryCache().find({ queryKey: builtInIconIndexQueryKey });
    if (!failedQuery) throw new Error("expected failed status query");
    expect(refetchIntervalFor(failedQuery)).toBe(false);
  });

  it("stores queued refresh responses in the status cache", async () => {
    const queryClient = createQueryClient();
    const queuedStatus = statusFixture("queued");
    const queuedProvider = queuedStatus.providers[0];
    const queuedJob = queuedProvider?.job;
    if (!queuedProvider || !queuedJob) throw new Error("expected queued provider job");
    vi.mocked(builtInIconIndexService.refresh).mockResolvedValue({
      status: queuedStatus,
      provider: queuedProvider,
      job: queuedJob,
    });

    const { result } = renderHook(() => useRefreshBuiltInIconIndexProvider(), { wrapper: createWrapper(queryClient) });
    await act(async () => {
      await result.current.mutateAsync("thesvg");
    });

    expect(queryClient.getQueryData<BuiltInIconIndexStatus>(builtInIconIndexQueryKey)?.providers[0]?.job?.status).toBe("queued");
  });
});

function refetchIntervalFor(query: Query): number | false | undefined {
  const refetchInterval = (query.options as {
    refetchInterval?: false | number | ((query: Query) => number | false | undefined);
  }).refetchInterval;
  return typeof refetchInterval === "function" ? refetchInterval(query) : refetchInterval;
}
