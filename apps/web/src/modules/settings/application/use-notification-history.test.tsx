// 通知历史 hook 测试保护 overview 与 history 的独立读取状态，筛选刷新不能清空实时概览。
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import { assertLocalTime } from "@/lib/time/local-time";
import type {
  NotificationHistoryJob,
  NotificationHistoryResponse,
  NotificationHistoryStatusFilter,
  NotificationOverviewResponse,
} from "@/lib/api/schemas/notifications";
import { useNotificationHistory } from "./use-notification-history";

type HistoryMock = (
  status: NotificationHistoryStatusFilter,
  limit: number,
  offset: number,
  signal?: AbortSignal,
) => Promise<NotificationHistoryResponse>;
type OverviewMock = (signal?: AbortSignal) => Promise<NotificationOverviewResponse>;

const mocks = vi.hoisted(() => ({
  history: vi.fn<HistoryMock>(),
  overview: vi.fn<OverviewMock>(),
}));

vi.mock("@/services/notification-service", () => ({
  notificationService: {
    history: mocks.history,
    overview: mocks.overview,
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createJob(status: NotificationHistoryStatusFilter): NotificationHistoryJob {
  const jobStatus = status === "skipped" ? "skipped" : "sent";
  return {
    id: `job-${status}`,
    scheduledLocalDate: assertDateOnly("2026-05-15"),
    scheduledLocalTime: assertLocalTime("08:00"),
    timeZone: "Asia/Shanghai",
    scheduledInstantUtc: "2026-05-15T00:00:00Z",
    status: jobStatus,
    attempts: 1,
    lastError: null,
    result: {},
    createdAt: "2026-05-15T00:00:00Z",
    updatedAt: "2026-05-15T00:00:00Z",
  };
}

function createOverviewResponse(nextCheckDate: string): NotificationOverviewResponse {
  const job = createJob("all");
  return {
    summary: {
      nextCheck: {
        scheduledLocalDate: assertDateOnly(nextCheckDate),
        scheduledLocalTime: assertLocalTime("08:00"),
        timeZone: "Asia/Shanghai",
        scheduledInstantUtc: `${nextCheckDate}T00:00:00Z`,
      },
      nextContentBatch: null,
      blockers: [],
      enabledChannels: ["email"],
      upcomingDays: 30,
      latestJob: job,
      latestFailedJob: null,
    },
    upcoming: [],
  };
}

function createHistoryResponse(
  status: NotificationHistoryStatusFilter,
): NotificationHistoryResponse {
  const job = createJob(status);
  return {
    jobs: [job],
    status,
    limit: 20,
    offset: 0,
    hasMore: false,
  };
}

describe("useNotificationHistory", () => {
  beforeEach(() => {
    mocks.history.mockReset();
    mocks.overview.mockReset();
  });

  it("keeps the schedule overview stable while a history status switch is loading", async () => {
    const skippedResponse = createDeferred<NotificationHistoryResponse>();
    mocks.overview.mockResolvedValue(createOverviewResponse("2026-05-16"));
    mocks.history.mockImplementation((status) => {
      if (status === "all") return Promise.resolve(createHistoryResponse("all"));
      return skippedResponse.promise;
    });

    const { result } = renderHook(() => useNotificationHistory(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.overview.data?.summary.nextCheck.scheduledLocalDate).toBe("2026-05-16");
      expect(result.current.history.data?.status).toBe("all");
    });

    act(() => {
      result.current.setStatus("skipped");
    });

    await waitFor(() => {
      expect(result.current.historyStatus).toBe("skipped");
    });

    expect(result.current.overview.data?.summary.nextCheck.scheduledLocalDate).toBe("2026-05-16");
    expect(result.current.overview.isRefreshing).toBe(false);
    expect(result.current.history.isRefreshing).toBe(true);
    expect(result.current.history.data?.status).toBe("skipped");
    expect(result.current.history.data?.jobs).toEqual([]);

    skippedResponse.resolve(createHistoryResponse("skipped"));

    await waitFor(() => {
      expect(result.current.history.isRefreshing).toBe(false);
    });

    expect(result.current.overview.data?.summary.nextCheck.scheduledLocalDate).toBe("2026-05-16");
    expect(result.current.history.data?.jobs).toHaveLength(1);
  });
});
