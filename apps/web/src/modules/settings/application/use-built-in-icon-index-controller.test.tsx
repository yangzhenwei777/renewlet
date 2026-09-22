import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltInIconIndexStatus, BuiltInIconRefreshJob, BuiltInIconRefreshJobStatus } from "@/lib/api/schemas/media";
import { useSettingsBuiltInIconIndexController } from "./use-built-in-icon-index-controller";

type AppToast = (typeof import("@/components/ui/sonner"))["toast"];

const mocks = vi.hoisted(() => ({
  toast: {
    success: vi.fn<AppToast["success"]>(),
    error: vi.fn<AppToast["error"]>(),
  },
  statusRefetch: vi.fn(),
  checkMutateAsync: vi.fn(),
  refreshMutateAsync: vi.fn(),
  status: undefined as BuiltInIconIndexStatus | undefined,
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: mocks.toast,
}));

vi.mock("@/hooks/use-built-in-icon-index", () => ({
  useBuiltInIconIndexStatus: () => ({
    data: mocks.status,
    isLoading: false,
    refetch: mocks.statusRefetch,
  }),
  useCheckBuiltInIconIndexProvider: () => ({
    mutateAsync: mocks.checkMutateAsync,
    isPending: false,
  }),
  useRefreshBuiltInIconIndexProvider: () => ({
    mutateAsync: mocks.refreshMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const messages: Record<string, string | ((params: Record<string, unknown>) => string)> = {
        "settings.builtInIconIndexRefreshFailed": "图标索引更新失败",
        "settings.builtInIconIndexRefreshFailedDescription": ({ source }) => `无法更新 ${source}，请稍后重试。`,
        "settings.builtInIconIndexUpdateQueued": ({ source }) => `${source} 会在后台更新；完成或失败后状态会自动停止轮询。`,
        "settings.builtInIconIndexUpdated": ({ source, count }) =>
          `${source} 已更新，${count} 个图标可用于 Logo 和图标搜索。`,
        "settings.builtInIconSourceShort.thesvg": "TheSVG",
      };
      const message = messages[key] ?? key;
      return typeof message === "function" ? message(params ?? {}) : message;
    },
  }),
}));

describe("useSettingsBuiltInIconIndexController", () => {
  beforeEach(() => {
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
    mocks.statusRefetch.mockReset();
    mocks.checkMutateAsync.mockReset();
    mocks.refreshMutateAsync.mockReset();
    mocks.status = statusFixture();
  });

  it("shows queued refresh jobs as background work", async () => {
    const queued = queuedJob();
    const queuedStatus = statusFixture(queued);
    mocks.refreshMutateAsync.mockResolvedValueOnce({
      status: queuedStatus,
      provider: queuedStatus.providers[0],
      job: queued,
    });

    const { result } = renderHook(() => useSettingsBuiltInIconIndexController(true));
    await act(async () => {
      await result.current.refreshProvider("thesvg");
    });

    expect(mocks.refreshMutateAsync).toHaveBeenCalledWith("thesvg");
    expect(mocks.toast.success).toHaveBeenCalledWith("TheSVG 会在后台更新；完成或失败后状态会自动停止轮询。");
  });

  it("shows a success toast once when a tracked Cloudflare refresh job succeeds", async () => {
    const queued = refreshJob("queued");
    const queuedStatus = statusFixture(queued);
    mocks.refreshMutateAsync.mockResolvedValueOnce({
      status: queuedStatus,
      provider: queuedStatus.providers[0],
      job: queued,
    });

    const { result, rerender } = renderHook(() => useSettingsBuiltInIconIndexController(true));
    await act(async () => {
      await result.current.refreshProvider("thesvg");
    });

    mocks.status = statusFixture(refreshJob("succeeded"), { thesvg: 120 });
    rerender();
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledTimes(2));
    expect(mocks.toast.success).toHaveBeenLastCalledWith("TheSVG 已更新，120 个图标可用于 Logo 和图标搜索。");

    rerender();
    expect(mocks.toast.success).toHaveBeenCalledTimes(2);
  });

  it("does not show completion toasts for historical terminal jobs", async () => {
    mocks.status = statusFixture(refreshJob("succeeded"), { thesvg: 120 });
    const { unmount } = renderHook(() => useSettingsBuiltInIconIndexController(true));

    await waitFor(() => {
      expect(mocks.toast.success).not.toHaveBeenCalled();
      expect(mocks.toast.error).not.toHaveBeenCalled();
    });
    unmount();

    mocks.status = statusFixture(refreshJob("failed", { error: "checksum mismatch" }));
    renderHook(() => useSettingsBuiltInIconIndexController(true));
    await waitFor(() => {
      expect(mocks.toast.success).not.toHaveBeenCalled();
      expect(mocks.toast.error).not.toHaveBeenCalled();
    });
  });

  it("shows a destructive toast when a tracked Cloudflare refresh job fails", async () => {
    const queued = refreshJob("running");
    const queuedStatus = statusFixture(queued);
    mocks.refreshMutateAsync.mockResolvedValueOnce({
      status: queuedStatus,
      provider: queuedStatus.providers[0],
      job: queued,
    });

    const { result, rerender } = renderHook(() => useSettingsBuiltInIconIndexController(true));
    await act(async () => {
      await result.current.refreshProvider("thesvg");
    });

    mocks.status = statusFixture(refreshJob("failed", { error: "checksum mismatch" }));
    rerender();

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledTimes(1));
    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
    expect(mocks.toast.error).toHaveBeenLastCalledWith("图标索引更新失败", {
      description: "checksum mismatch",
    });
  });

  it("keeps Docker immediate refresh success as a single success toast", async () => {
    const succeeded = refreshJob("succeeded");
    const succeededStatus = statusFixture(succeeded, { thesvg: 120 });
    mocks.refreshMutateAsync.mockResolvedValueOnce({
      status: succeededStatus,
      provider: succeededStatus.providers[0],
      job: succeeded,
    });

    const { result, rerender } = renderHook(() => useSettingsBuiltInIconIndexController(true));
    await act(async () => {
      await result.current.refreshProvider("thesvg");
    });

    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).toHaveBeenCalledWith("TheSVG 已更新，120 个图标可用于 Logo 和图标搜索。");

    mocks.status = succeededStatus;
    rerender();
    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
  });

  it("checks providers serially from the dialog while skipping providers already refreshing", async () => {
    mocks.status = statusFixture(queuedJob());
    const order: string[] = [];
    mocks.checkMutateAsync.mockImplementation(async (provider: string) => {
      order.push(provider);
    });

    const { result } = renderHook(() => useSettingsBuiltInIconIndexController(true));
    await act(async () => {
      await result.current.checkAllProviders();
    });

    expect(order).toEqual(["selfhst", "dashboardIcons"]);
    expect(mocks.checkMutateAsync).not.toHaveBeenCalledWith("thesvg");
  });
});

function statusFixture(
  job?: BuiltInIconIndexStatus["providers"][number]["job"],
  iconCounts: Partial<Record<"thesvg" | "selfhst" | "dashboardIcons", number>> = {},
): BuiltInIconIndexStatus {
  return {
    source: "embedded",
    hash: "embedded-hash",
    iconCount: 3,
    providerCounts: { thesvg: 1, selfhst: 1, dashboardIcons: 1 },
    checkedAt: null,
    updatedAt: null,
    refreshing: Boolean(job?.status === "queued" || job?.status === "running"),
    providers: ["thesvg", "selfhst", "dashboardIcons"].map((provider) => ({
      provider: provider as "thesvg" | "selfhst" | "dashboardIcons",
      current: null,
      latest: null,
      iconCount: iconCounts[provider as "thesvg" | "selfhst" | "dashboardIcons"] ?? 1,
      checkedAt: null,
      refreshedAt: null,
      lastError: null,
      refreshing: provider === job?.provider && Boolean(job?.status === "queued" || job?.status === "running"),
      updateAvailable: false,
      ...(provider === job?.provider && job ? { job } : {}),
    })),
  };
}

function queuedJob() {
  return refreshJob("queued");
}

function refreshJob(status: BuiltInIconRefreshJobStatus, overrides: Partial<BuiltInIconRefreshJob> = {}): BuiltInIconRefreshJob {
  return {
    id: "job_queued",
    provider: "thesvg" as const,
    status,
    queuedAt: "2026-06-11T00:00:00Z",
    startedAt: status === "queued" ? null : "2026-06-11T00:00:01Z",
    finishedAt: status === "queued" || status === "running" ? null : "2026-06-11T00:00:02Z",
    attempts: status === "queued" ? 0 : 1,
    error: status === "failed" ? "refresh failed" : null,
    indexHash: status === "succeeded" ? "a".repeat(64) : null,
    ...overrides,
  };
}
