// 云备份 hook 测试保护快照列表缓存边界：远端 list 成本高，自动 remount/focus refetch 不能绕过显式刷新入口。
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_BACKUP_SNAPSHOTS_QUERY_KEY,
  CLOUD_BACKUP_SNAPSHOTS_STALE_TIME_MS,
  useCloudBackupSnapshots,
  useCreateCloudBackupSnapshot,
  useDeleteCloudBackupSnapshot,
} from "./use-cloud-backup";
import type { CloudBackupCreateSnapshotRequest, CloudBackupSnapshot } from "@/lib/api/schemas/cloud-backup";

type SnapshotQueryTestProps = {
  provider: "webdav" | "s3";
  configUpdatedAt: string;
  locale: "en-US" | "zh-CN";
};

const mocks = vi.hoisted(() => ({
  listSnapshots: vi.fn<(provider: "webdav" | "s3", signal?: AbortSignal) => Promise<CloudBackupSnapshot[]>>(),
  createSnapshot: vi.fn<(payload: CloudBackupCreateSnapshotRequest) => Promise<CloudBackupSnapshot[]>>(),
  deleteSnapshot: vi.fn<(snapshot: CloudBackupSnapshot) => Promise<void>>(),
}));

vi.mock("@/services/cloud-backup-service", () => ({
  cloudBackupService: {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    test: vi.fn(),
    listSnapshots: mocks.listSnapshots,
    createSnapshot: mocks.createSnapshot,
    downloadSnapshot: vi.fn(),
    deleteSnapshot: mocks.deleteSnapshot,
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

function snapshot(id: string, provider: "webdav" | "s3" = "webdav"): CloudBackupSnapshot {
  return {
    id,
    filename: `renewlet-${id}.zip`,
    provider,
    createdAt: "2026-06-09T00:00:00.000Z",
    sizeBytes: 1024,
    sha256: "a".repeat(64),
  };
}

describe("useCloudBackupSnapshots", () => {
  beforeEach(() => {
    mocks.listSnapshots.mockReset();
    mocks.createSnapshot.mockReset();
    mocks.deleteSnapshot.mockReset();
  });

  it("keeps provider snapshots fresh across quick remounts", async () => {
    const queryClient = createQueryClient();
    const wrapper = createWrapper(queryClient);
    mocks.listSnapshots.mockResolvedValue([snapshot("webdav-1")]);

    const first = renderHook(() => useCloudBackupSnapshots({ provider: "webdav", configUpdatedAt: "v1", locale: "zh-CN" }), { wrapper });
    await waitFor(() => expect(first.result.current.data).toHaveLength(1));
    expect(mocks.listSnapshots).toHaveBeenCalledTimes(1);
    expect(mocks.listSnapshots).toHaveBeenLastCalledWith("webdav", expect.any(AbortSignal));

    first.unmount();
    const second = renderHook(() => useCloudBackupSnapshots({ provider: "webdav", configUpdatedAt: "v1", locale: "zh-CN" }), { wrapper });
    await waitFor(() => expect(second.result.current.data).toHaveLength(1));

    expect(mocks.listSnapshots).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData([...CLOUD_BACKUP_SNAPSHOTS_QUERY_KEY, "webdav", "v1", "zh-CN"])).toEqual([snapshot("webdav-1")]);
    expect(queryClient.getQueryCache().find({ queryKey: [...CLOUD_BACKUP_SNAPSHOTS_QUERY_KEY, "webdav", "v1", "zh-CN"] })?.options).toMatchObject({
      staleTime: CLOUD_BACKUP_SNAPSHOTS_STALE_TIME_MS,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
    });
  });

  it("keeps provider, config timestamp and locale in the query boundary", async () => {
    const queryClient = createQueryClient();
    const wrapper = createWrapper(queryClient);
    mocks.listSnapshots
      .mockResolvedValueOnce([snapshot("webdav-1", "webdav")])
      .mockResolvedValueOnce([snapshot("s3-1", "s3")])
      .mockResolvedValueOnce([snapshot("webdav-2", "webdav")])
      .mockResolvedValueOnce([snapshot("webdav-zh", "webdav")]);

    const initialProps: SnapshotQueryTestProps = { provider: "webdav", configUpdatedAt: "v1", locale: "en-US" };
    const rendered = renderHook(
      ({ provider, configUpdatedAt, locale }: SnapshotQueryTestProps) =>
        useCloudBackupSnapshots({ provider, configUpdatedAt, locale }),
      { wrapper, initialProps },
    );
    await waitFor(() => expect(rendered.result.current.data).toEqual([snapshot("webdav-1", "webdav")]));

    rendered.rerender({ provider: "s3", configUpdatedAt: "v1", locale: "en-US" });
    await waitFor(() => expect(rendered.result.current.data).toEqual([snapshot("s3-1", "s3")]));

    rendered.rerender({ provider: "webdav", configUpdatedAt: "v2", locale: "en-US" });
    await waitFor(() => expect(rendered.result.current.data).toEqual([snapshot("webdav-2", "webdav")]));

    rendered.rerender({ provider: "webdav", configUpdatedAt: "v2", locale: "zh-CN" });
    await waitFor(() => expect(rendered.result.current.data).toEqual([snapshot("webdav-zh", "webdav")]));

    expect(mocks.listSnapshots.mock.calls.map(([provider]) => provider)).toEqual(["webdav", "s3", "webdav", "webdav"]);
  });

  it("still refetches through the explicit refresh API", async () => {
    const wrapper = createWrapper(createQueryClient());
    mocks.listSnapshots
      .mockResolvedValueOnce([snapshot("webdav-1")])
      .mockResolvedValueOnce([snapshot("webdav-2")]);

    const { result } = renderHook(() => useCloudBackupSnapshots({ provider: "webdav", configUpdatedAt: "v1", locale: "zh-CN" }), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([snapshot("webdav-1")]));

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.data).toEqual([snapshot("webdav-2")]));
    expect(mocks.listSnapshots).toHaveBeenCalledTimes(2);
  });
});

describe("cloud backup snapshot mutations", () => {
  beforeEach(() => {
    mocks.listSnapshots.mockReset();
    mocks.createSnapshot.mockReset();
    mocks.deleteSnapshot.mockReset();
  });

  it("invalidates snapshots after creating or deleting a snapshot", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData([...CLOUD_BACKUP_SNAPSHOTS_QUERY_KEY, "webdav", "v1", "zh-CN"], [snapshot("old")]);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    mocks.createSnapshot.mockResolvedValue([snapshot("created")]);
    mocks.deleteSnapshot.mockResolvedValue(undefined);
    const wrapper = createWrapper(queryClient);

    const create = renderHook(() => useCreateCloudBackupSnapshot(), { wrapper });
    await act(async () => {
      await create.result.current.mutateAsync({
        provider: "webdav",
      });
    });

    const remove = renderHook(() => useDeleteCloudBackupSnapshot(), { wrapper });
    await act(async () => {
      await remove.result.current.mutateAsync(snapshot("created"));
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: CLOUD_BACKUP_SNAPSHOTS_QUERY_KEY });
    expect(invalidateSpy.mock.calls.filter(([arg]) => arg?.queryKey === CLOUD_BACKUP_SNAPSHOTS_QUERY_KEY)).toHaveLength(2);
  });
});
