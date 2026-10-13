import { vi } from "vitest";
import type { CloudBackupController } from "../application/use-cloud-backup-controller";
import type { SettingsReadState } from "../application/settings-read-state";

function createReadState<T>(data: T): SettingsReadState<T> {
  return {
    data,
    hasData: true,
    error: null,
    isInitialLoading: false,
    isRefreshing: false,
    retry: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

export function createCloudBackupControllerState(): CloudBackupController {
  const fn = vi.fn();
  const defaultPolicy = {
    scheduleEnabled: false,
    scheduleFrequency: "daily" as const,
    scheduleTime: "03:00",
    scheduleWeekday: "monday" as const,
    retention: 7,
  };
  const defaultStatus = {
    lastBackupAt: null,
    lastStatus: "idle" as const,
    lastError: null,
    updatedAt: null,
  };
  return {
    config: createReadState({
      provider: "webdav" as const,
      credentialSet: false,
      credentialSetByProvider: { webdav: false, s3: false },
      policyByProvider: { webdav: defaultPolicy, s3: defaultPolicy },
      statusByProvider: { webdav: defaultStatus, s3: defaultStatus },
      updatedAt: null,
    }),
    snapshots: createReadState([]),
    isInitialLayoutReady: true,
    form: {
      provider: "webdav" as const,
      webdavUrl: "",
      webdavUsername: "",
      webdavPassword: "",
      webdavPath: "renewlet",
      s3Endpoint: "",
      s3Region: "",
      s3Bucket: "",
      s3Prefix: "renewlet",
      s3AddressingStyle: "auto",
      s3AccessKeyId: "",
      s3SecretAccessKey: "",
      scheduleEnabled: false,
      scheduleFrequency: "daily" as const,
      scheduleTime: "03:00",
      scheduleWeekday: "monday" as const,
      retention: "7",
    },
    credentialSet: false,
    canCreateSnapshot: false,
    isSaving: false,
    isTesting: false,
    isCreating: false,
    isDownloading: false,
    isDeleting: false,
    restoringSnapshotKey: null,
    deletingSnapshotKey: null,
    hasUnsavedChanges: false,
    snapshotsErrorMessage: null,
    cloudBackupErrorDetails: null,
    cloudBackupErrorDetailsContext: null,
    cloudBackupErrorDetailsOpen: false,
    setCloudBackupErrorDetailsOpen: fn,
    openSnapshotsErrorDetails: fn,
    updateForm: fn,
    saveConfig: fn,
    testConfig: fn,
    createSnapshot: fn,
    restoreSnapshot: fn,
    deleteSnapshot: fn,
  };
}

