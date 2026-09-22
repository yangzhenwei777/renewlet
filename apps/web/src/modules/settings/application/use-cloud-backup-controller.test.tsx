import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCloudBackupController } from "./use-cloud-backup-controller";
import { ApiError } from "@/lib/api-client";
import type {
  CloudBackupConfig,
  CloudBackupConfigUpdate,
  CloudBackupPolicy,
  CloudBackupSnapshot,
} from "@/lib/api/schemas/cloud-backup";

// Controller 测试保护 provider 草稿隔离、write-only secret 和快照行级状态，避免 UI mock 掩盖串目标问题。
type AppToast = (typeof import("@/components/ui/sonner"))["toast"];

const mocks = vi.hoisted(() => ({
  toast: {
    success: vi.fn<AppToast["success"]>(),
    error: vi.fn<AppToast["error"]>(),
  },
  locale: "zh-CN" as "zh-CN" | "en-US",
  config: null as CloudBackupConfig | null,
  configPending: false,
  snapshots: [] as CloudBackupSnapshot[],
  snapshotsError: null as Error | null,
  snapshotQueryParams: [] as Array<{ enabled?: boolean; provider: CloudBackupConfig["provider"]; configUpdatedAt?: string | null; locale: "zh-CN" | "en-US" }>,
  updateConfigMutateAsync: vi.fn(),
  testMutateAsync: vi.fn(),
  createSnapshotMutateAsync: vi.fn(),
  downloadSnapshotMutateAsync: vi.fn(),
  deleteSnapshotMutateAsync: vi.fn(),
  refetchSnapshots: vi.fn(),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: mocks.toast,
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => (key === "settings.cloudBackupSnapshotsLoadFailed" ? "云端快照列表加载失败" : key),
  }),
}));

vi.mock("@/i18n/api-locale", () => ({
  getApiLocale: () => mocks.locale,
}));

vi.mock("@/hooks/use-cloud-backup", () => ({
  useCloudBackupConfig: () => ({
    data: mocks.config ?? undefined,
    error: null,
    isFetched: !mocks.configPending,
    isPending: mocks.configPending,
    isFetching: mocks.configPending,
    refetch: vi.fn(),
  }),
  useCloudBackupSnapshots: (params: { enabled?: boolean; provider: CloudBackupConfig["provider"]; configUpdatedAt?: string | null; locale: "zh-CN" | "en-US" }) => {
    mocks.snapshotQueryParams.push(params);
    return {
      data: mocks.snapshots,
      error: mocks.snapshotsError,
      isFetched: true,
      isPending: false,
      isFetching: false,
      refetch: mocks.refetchSnapshots,
    };
  },
  useUpdateCloudBackupConfig: () => ({
    mutateAsync: mocks.updateConfigMutateAsync,
    isPending: false,
  }),
  useTestCloudBackup: () => ({
    mutateAsync: mocks.testMutateAsync,
    isPending: false,
  }),
  useCreateCloudBackupSnapshot: () => ({
    mutateAsync: mocks.createSnapshotMutateAsync,
    isPending: false,
  }),
  useDownloadCloudBackupSnapshot: () => ({
    mutateAsync: mocks.downloadSnapshotMutateAsync,
    isPending: false,
  }),
  useDeleteCloudBackupSnapshot: () => ({
    mutateAsync: mocks.deleteSnapshotMutateAsync,
    isPending: false,
  }),
}));

const webdavPolicy: CloudBackupPolicy = {
  scheduleEnabled: false,
  scheduleFrequency: "daily",
  scheduleTime: "03:00",
  scheduleWeekday: "monday",
  retention: 7,
};

const s3Policy: CloudBackupPolicy = {
  scheduleEnabled: true,
  scheduleFrequency: "weekly",
  scheduleTime: "04:30",
  scheduleWeekday: "friday",
  retention: 9,
};

function createConfig(overrides: {
  provider?: CloudBackupConfig["provider"];
  webdavPolicy?: CloudBackupPolicy;
  s3Policy?: CloudBackupPolicy;
  updatedAt?: string | null;
} = {}): CloudBackupConfig {
  const provider = overrides.provider ?? "webdav";
  return {
    provider,
    webdav: {
      url: "https://dav.example.com/remote.php/dav/files/alice",
      username: "alice",
      path: "renewlet",
    },
    s3: {
      endpoint: "https://account.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "renewlet",
      prefix: "renewlet",
      accessKeyId: "access",
    },
    credentialSet: true,
    credentialSetByProvider: { webdav: true, s3: true },
    policyByProvider: {
      webdav: overrides.webdavPolicy ?? webdavPolicy,
      s3: overrides.s3Policy ?? s3Policy,
    },
    statusByProvider: {
      webdav: { lastBackupAt: null, lastStatus: "idle", lastError: null, updatedAt: overrides.updatedAt ?? null },
      s3: { lastBackupAt: null, lastStatus: "idle", lastError: null, updatedAt: overrides.updatedAt ?? null },
    },
    updatedAt: overrides.updatedAt ?? "2026-06-09T00:00:00.000Z",
  };
}

async function renderController() {
  const rendered = renderHook(() => useCloudBackupController(vi.fn()));
  await waitFor(() => {
    expect(rendered.result.current.form.webdavUrl).toBe("https://dav.example.com/remote.php/dav/files/alice");
  });
  return rendered;
}

describe("useCloudBackupController provider drafts", () => {
  beforeEach(() => {
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
    mocks.locale = "zh-CN";
    mocks.config = createConfig();
    mocks.configPending = false;
    mocks.snapshots = [];
    mocks.snapshotsError = null;
    mocks.snapshotQueryParams = [];
    mocks.updateConfigMutateAsync.mockReset();
    mocks.testMutateAsync.mockReset();
    mocks.createSnapshotMutateAsync.mockReset();
    mocks.downloadSnapshotMutateAsync.mockReset();
    mocks.deleteSnapshotMutateAsync.mockReset();
    mocks.refetchSnapshots.mockReset();
    mocks.updateConfigMutateAsync.mockImplementation(async (payload: CloudBackupConfigUpdate) => {
      const current = mocks.config ?? createConfig();
      const next = createConfig({
        provider: payload.provider,
        webdavPolicy: payload.provider === "webdav" ? payload.policy : current.policyByProvider.webdav,
        s3Policy: payload.provider === "s3" ? payload.policy : current.policyByProvider.s3,
        updatedAt: "2026-06-09T00:10:00.000Z",
      });
      mocks.config = next;
      return next;
    });
    mocks.testMutateAsync.mockResolvedValue({ checkedAt: "2026-06-09T00:00:00.000Z" });
    mocks.createSnapshotMutateAsync.mockResolvedValue([]);
  });

  it("reports stable layout only after initial config and draft synchronization", async () => {
    mocks.config = null;
    mocks.configPending = true;
    const { result, rerender } = renderHook(() => useCloudBackupController(vi.fn()));

    expect(result.current.isInitialLayoutReady).toBe(false);

    mocks.config = createConfig();
    mocks.configPending = false;
    rerender();

    await waitFor(() => {
      expect(result.current.isInitialLayoutReady).toBe(true);
    });
    expect(result.current.form.webdavUrl).toBe("https://dav.example.com/remote.php/dav/files/alice");
  });

  it("keeps WebDAV and S3 policy drafts isolated while switching providers", async () => {
    const { result } = await renderController();

    act(() => {
      result.current.updateForm("scheduleEnabled", true);
      result.current.updateForm("scheduleFrequency", "weekly");
      result.current.updateForm("scheduleWeekday", "sunday");
      result.current.updateForm("scheduleTime", "05:45");
      result.current.updateForm("retention", "12");
    });

    expect(result.current.form.provider).toBe("webdav");
    expect(result.current.form.scheduleTime).toBe("05:45");
    expect(result.current.form.retention).toBe("12");

    act(() => {
      result.current.updateForm("provider", "s3");
    });

    expect(result.current.form.provider).toBe("s3");
    expect(result.current.form.scheduleEnabled).toBe(true);
    expect(result.current.form.scheduleFrequency).toBe("weekly");
    expect(result.current.form.scheduleWeekday).toBe("friday");
    expect(result.current.form.scheduleTime).toBe("04:30");
    expect(result.current.form.retention).toBe("9");

    act(() => {
      result.current.updateForm("retention", "21");
      result.current.updateForm("provider", "webdav");
    });

    expect(result.current.form.scheduleWeekday).toBe("sunday");
    expect(result.current.form.scheduleTime).toBe("05:45");
    expect(result.current.form.retention).toBe("12");

    act(() => {
      result.current.updateForm("provider", "s3");
    });

    expect(result.current.form.retention).toBe("21");
  });

  it("saves only the active provider payload and preserves the other provider dirty draft", async () => {
    const { result } = await renderController();

    act(() => {
      result.current.updateForm("provider", "s3");
      result.current.updateForm("s3SecretAccessKey", "s3-secret");
      result.current.updateForm("retention", "21");
      result.current.updateForm("provider", "webdav");
      result.current.updateForm("webdavPassword", "dav-secret");
      result.current.updateForm("retention", "12");
    });

    await act(async () => {
      await result.current.saveConfig();
    });

    const webdavPayload = mocks.updateConfigMutateAsync.mock.calls[0]?.[0] as CloudBackupConfigUpdate;
    expect(webdavPayload.provider).toBe("webdav");
    expect(webdavPayload.policy.retention).toBe(12);
    expect(webdavPayload.credentials).toEqual({ webdavPassword: "dav-secret" });
    expect(webdavPayload.s3).toBeUndefined();
    expect(result.current.form.webdavPassword).toBe("");

    act(() => {
      result.current.updateForm("provider", "s3");
    });

    expect(result.current.form.s3SecretAccessKey).toBe("s3-secret");
    expect(result.current.form.retention).toBe("21");

    await act(async () => {
      await result.current.saveConfig();
    });

    const s3Payload = mocks.updateConfigMutateAsync.mock.calls[1]?.[0] as CloudBackupConfigUpdate;
    expect(s3Payload.provider).toBe("s3");
    expect(s3Payload.policy.retention).toBe(21);
    expect(s3Payload.s3).not.toHaveProperty("addressingStyle");
    expect(s3Payload.credentials).toEqual({ s3SecretAccessKey: "s3-secret" });
    expect(s3Payload.webdav).toBeUndefined();
  });

  it("blocks S3 save and test when signing region is empty", async () => {
    const { result } = await renderController();

    act(() => {
      result.current.updateForm("provider", "s3");
      result.current.updateForm("s3Region", "");
    });

    await act(async () => {
      await result.current.saveConfig();
      await result.current.testConfig();
    });

    expect(mocks.updateConfigMutateAsync).not.toHaveBeenCalled();
    expect(mocks.testMutateAsync).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith("settings.cloudBackupInvalid", {
      description: "settings.cloudBackupInvalidDescription",
    });
  });

  it("does not overwrite a dirty provider draft when cloud config refetches", async () => {
    const { result, rerender } = await renderController();

    act(() => {
      result.current.updateForm("retention", "12");
    });

    mocks.config = createConfig({
      webdavPolicy: { ...webdavPolicy, retention: 15 },
      s3Policy: { ...s3Policy, retention: 10 },
      updatedAt: "2026-06-09T00:20:00.000Z",
    });
    rerender();

    await waitFor(() => {
      expect(result.current.form.provider).toBe("webdav");
      expect(result.current.form.retention).toBe("12");
    });

    act(() => {
      result.current.updateForm("provider", "s3");
    });

    expect(result.current.form.retention).toBe("10");
  });

  it("creates snapshots for the active provider only", async () => {
    const { result } = await renderController();

    act(() => {
      result.current.updateForm("provider", "s3");
    });

    await act(async () => {
      await result.current.createSnapshot();
    });

    expect(mocks.createSnapshotMutateAsync).toHaveBeenCalledWith({ provider: "s3" });
  });

  it("exposes the snapshot being restored while download is pending and clears it on success", async () => {
    const onRestoreFile = vi.fn();
    const rendered = renderHook(() => useCloudBackupController(onRestoreFile));
    await waitFor(() => {
      expect(rendered.result.current.form.webdavUrl).toBe("https://dav.example.com/remote.php/dav/files/alice");
    });
    const snapshot: CloudBackupSnapshot = {
      id: "restore-id",
      filename: "restore.zip",
      provider: "webdav",
      createdAt: "2026-06-09T00:00:00.000Z",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
    };
    let resolveDownload: (blob: Blob) => void = () => undefined;
    mocks.downloadSnapshotMutateAsync.mockImplementationOnce(() => new Promise<Blob>((resolve) => {
      resolveDownload = resolve;
    }));

    let restorePromise: Promise<void>;
    await act(async () => {
      restorePromise = rendered.result.current.restoreSnapshot(snapshot);
    });

    expect(rendered.result.current.restoringSnapshotKey).toBe("webdav:restore-id");

    await act(async () => {
      resolveDownload(new Blob(["zip"], { type: "application/zip" }));
      await restorePromise;
    });

    expect(rendered.result.current.restoringSnapshotKey).toBeNull();
    expect(onRestoreFile).toHaveBeenCalledWith(expect.objectContaining({ name: "restore.zip" }));
  });

  it("clears restoring snapshot key and opens upstream details when restore download fails", async () => {
    const { result } = await renderController();
    const snapshot: CloudBackupSnapshot = {
      id: "failed-restore-id",
      filename: "failed.zip",
      provider: "s3",
      createdAt: "2026-06-09T00:00:00.000Z",
      sizeBytes: 1024,
      sha256: "b".repeat(64),
    };
    let rejectDownload: (error: unknown) => void = () => undefined;
    mocks.downloadSnapshotMutateAsync.mockImplementationOnce(() => new Promise<Blob>((_resolve, reject) => {
      rejectDownload = reject;
    }));

    let restorePromise: Promise<void>;
    await act(async () => {
      restorePromise = result.current.restoreSnapshot(snapshot);
    });

    expect(result.current.restoringSnapshotKey).toBe("s3:failed-restore-id");

    const rawResponse = "{\"error\":{\"code\":\"CLOUD_BACKUP_S3_GET_FAILED\",\"message\":\"云端快照恢复失败\",\"details\":{\"rawResponseText\":\"<Error><Code>AccessDenied</Code></Error>\"}}}";
    await act(async () => {
      rejectDownload(new ApiError(
        "云端快照恢复失败",
        400,
        {
          rawResponseText: "<Error><Code>AccessDenied</Code></Error>",
        },
        "CLOUD_BACKUP_S3_GET_FAILED",
        rawResponse,
      ));
      await restorePromise;
    });

    expect(result.current.restoringSnapshotKey).toBeNull();
    expect(result.current.cloudBackupErrorDetailsOpen).toBe(true);
    expect(result.current.cloudBackupErrorDetails).toMatchObject({
      message: "云端快照恢复失败",
      responseText: "<Error><Code>AccessDenied</Code></Error>",
    });
  });

  it("exposes the snapshot being deleted while delete is pending and clears it on success", async () => {
    const { result } = await renderController();
    const snapshot: CloudBackupSnapshot = {
      id: "delete-id",
      filename: "delete.zip",
      provider: "webdav",
      createdAt: "2026-06-09T00:00:00.000Z",
      sizeBytes: 1024,
      sha256: "c".repeat(64),
    };
    let resolveDelete: () => void = () => undefined;
    mocks.deleteSnapshotMutateAsync.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveDelete = resolve;
    }));

    let deletePromise: Promise<void>;
    await act(async () => {
      deletePromise = result.current.deleteSnapshot(snapshot);
    });

    expect(result.current.deletingSnapshotKey).toBe("webdav:delete-id");

    await act(async () => {
      resolveDelete();
      await deletePromise;
    });

    expect(result.current.deletingSnapshotKey).toBeNull();
    expect(mocks.deleteSnapshotMutateAsync).toHaveBeenCalledWith(snapshot);
  });

  it("clears deleting snapshot key and opens upstream details when delete fails", async () => {
    const { result } = await renderController();
    const snapshot: CloudBackupSnapshot = {
      id: "failed-delete-id",
      filename: "failed-delete.zip",
      provider: "s3",
      createdAt: "2026-06-09T00:00:00.000Z",
      sizeBytes: 1024,
      sha256: "d".repeat(64),
    };
    let rejectDelete: (error: unknown) => void = () => undefined;
    mocks.deleteSnapshotMutateAsync.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectDelete = reject;
    }));

    let deletePromise: Promise<void>;
    await act(async () => {
      deletePromise = result.current.deleteSnapshot(snapshot);
    });

    expect(result.current.deletingSnapshotKey).toBe("s3:failed-delete-id");

    const rawResponse = "{\"error\":{\"code\":\"CLOUD_BACKUP_S3_DELETE_FAILED\",\"message\":\"云端快照删除失败\",\"details\":{\"rawResponseText\":\"<Error><Code>AccessDenied</Code></Error>\"}}}";
    await act(async () => {
      rejectDelete(new ApiError(
        "云端快照删除失败",
        400,
        {
          rawResponseText: "<Error><Code>AccessDenied</Code></Error>",
        },
        "CLOUD_BACKUP_S3_DELETE_FAILED",
        rawResponse,
      ));
      await deletePromise;
    });

    expect(result.current.deletingSnapshotKey).toBeNull();
    expect(result.current.cloudBackupErrorDetailsOpen).toBe(true);
    expect(result.current.cloudBackupErrorDetails).toMatchObject({
      message: "云端快照删除失败",
      responseText: "<Error><Code>AccessDenied</Code></Error>",
    });
  });

  it("opens upstream details for local SDK cloud backup test errors", async () => {
    const { result } = await renderController();
    const rawResponse = "{\"error\":{\"code\":\"CLOUD_BACKUP_TEST_FAILED\",\"message\":\"云备份连接测试失败\",\"details\":{\"rawResponseText\":\"Value out of range. Must be between -2147483648 and 2147483647 (inclusive).\"}}}";
    mocks.testMutateAsync.mockRejectedValueOnce(new ApiError(
      "云备份连接测试失败",
      400,
      {
        rawResponseText: "Value out of range. Must be between -2147483648 and 2147483647 (inclusive).",
      },
      "CLOUD_BACKUP_TEST_FAILED",
      rawResponse,
    ));

    await act(async () => {
      await result.current.testConfig();
    });

    expect(result.current.cloudBackupErrorDetailsOpen).toBe(true);
    expect(result.current.cloudBackupErrorDetails?.message).toBe("云备份连接测试失败");
    expect(result.current.cloudBackupErrorDetails?.responseText).toBe("Value out of range. Must be between -2147483648 and 2147483647 (inclusive).");
  });

  it("queries snapshots for the active provider only", async () => {
    const { result } = await renderController();

    expect(mocks.snapshotQueryParams[mocks.snapshotQueryParams.length - 1]).toMatchObject({
      enabled: true,
      provider: "webdav",
      locale: "zh-CN",
    });

    act(() => {
      result.current.updateForm("provider", "s3");
    });

    await waitFor(() => {
      expect(mocks.snapshotQueryParams[mocks.snapshotQueryParams.length - 1]).toMatchObject({
        enabled: true,
        provider: "s3",
        locale: "zh-CN",
      });
    });
  });

  it("uses current UI copy for stale localized cloud backup list errors", async () => {
    mocks.snapshotsError = new ApiError(
      "Failed to load cloud backups",
      400,
      {
        rawResponseText: "internal error",
      },
      "CLOUD_BACKUP_LIST_FAILED",
      "{\"error\":{\"code\":\"CLOUD_BACKUP_LIST_FAILED\",\"message\":\"Failed to load cloud backups\",\"details\":{\"rawResponseText\":\"internal error\"}}}",
    );

    const { result } = await renderController();

    expect(result.current.snapshotsErrorMessage).toBe("云端快照列表加载失败");
    act(() => {
      result.current.openSnapshotsErrorDetails();
    });
    expect(result.current.cloudBackupErrorDetails?.message).toBe("Failed to load cloud backups");
    expect(result.current.cloudBackupErrorDetails?.responseText).toBe("internal error");
  });
});
