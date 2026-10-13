import { useState } from "react";
import { vi } from "vitest";
import { CloudBackupSection } from "./cloud-backup-section";
import type { CloudBackupController, CloudBackupFormState } from "../application/use-cloud-backup-controller";
import type { CloudBackupConfig, CloudBackupPolicy, CloudBackupSnapshot } from "@/lib/api/schemas/cloud-backup";
import type { SettingsReadState } from "../application/settings-read-state";
export function installPointerCaptureMocks() {
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: vi.fn(() => false),
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
}

const defaultForm: CloudBackupFormState = {
  provider: "webdav",
  webdavUrl: "https://dav.example.com/remote.php/dav/files/alice",
  webdavUsername: "alice",
  webdavPassword: "",
  webdavPath: "renewlet",
  s3Endpoint: "https://account.r2.cloudflarestorage.com",
  s3Region: "auto",
  s3Bucket: "renewlet",
  s3Prefix: "renewlet",
  s3AddressingStyle: "auto",
  s3AccessKeyId: "access",
  s3SecretAccessKey: "",
  scheduleEnabled: false,
  scheduleFrequency: "daily",
  scheduleTime: "03:00",
  scheduleWeekday: "monday",
  retention: "7",
};

const defaultPolicy: CloudBackupPolicy = {
  scheduleEnabled: false,
  scheduleFrequency: "daily" as const,
  scheduleTime: "03:00",
  scheduleWeekday: "monday" as const,
  retention: 7,
};

const s3Policy: CloudBackupPolicy = {
  scheduleEnabled: true,
  scheduleFrequency: "weekly" as const,
  scheduleTime: "04:30",
  scheduleWeekday: "friday" as const,
  retention: 9,
};

const defaultStatus = {
  lastBackupAt: null,
  lastStatus: "idle" as const,
  lastError: null,
  updatedAt: "2026-06-09T00:00:00.000Z",
};

const webdavStatus = {
  lastBackupAt: "2026-06-09T11:56:00.000Z",
  lastStatus: "success" as const,
  lastError: null,
  updatedAt: "2026-06-09T11:56:00.000Z",
};

const s3Status = {
  lastBackupAt: null,
  lastStatus: "failed" as const,
  lastError: "S3 权限不足",
  updatedAt: "2026-06-09T12:00:00.000Z",
};

export function readState<T>(data: T | undefined, overrides: Partial<SettingsReadState<T>> = {}): SettingsReadState<T> {
  return {
    data,
    hasData: data !== undefined,
    error: null,
    isInitialLoading: false,
    isRefreshing: false,
    retry: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

function defaultConfigData(): CloudBackupConfig {
  return {
    provider: defaultForm.provider,
    credentialSet: true,
    credentialSetByProvider: { webdav: true, s3: false },
    policyByProvider: { webdav: defaultPolicy, s3: defaultPolicy },
    statusByProvider: { webdav: defaultStatus, s3: defaultStatus },
    updatedAt: "2026-06-09T00:00:00.000Z",
  };
}

export function createController(overrides: Partial<CloudBackupController> = {}): CloudBackupController {
  return {
    config: readState(defaultConfigData()),
    snapshots: readState([]),
    isInitialLayoutReady: true,
    form: defaultForm,
    credentialSet: true,
    canCreateSnapshot: true,
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
    setCloudBackupErrorDetailsOpen: vi.fn(),
    openSnapshotsErrorDetails: vi.fn(),
    updateForm: vi.fn(),
    saveConfig: vi.fn(async () => undefined),
    testConfig: vi.fn(async () => undefined),
    createSnapshot: vi.fn(async () => undefined),
    restoreSnapshot: vi.fn(async () => undefined),
    deleteSnapshot: vi.fn(async () => undefined),
    ...overrides,
  };
}
type TestDraftByProvider = Record<CloudBackupFormState["provider"], CloudBackupFormState>;

function createTestDraft(provider: CloudBackupFormState["provider"], policy: CloudBackupPolicy = defaultPolicy): CloudBackupFormState {
  return {
    ...defaultForm,
    provider,
    scheduleEnabled: policy.scheduleEnabled,
    scheduleFrequency: policy.scheduleFrequency,
    scheduleTime: policy.scheduleTime,
    scheduleWeekday: policy.scheduleWeekday,
    retention: String(policy.retention),
  };
}

function formFromTestDrafts(provider: CloudBackupFormState["provider"], drafts: TestDraftByProvider): CloudBackupFormState {
  const activeDraft = drafts[provider];
  return {
    ...activeDraft,
    provider,
    webdavUrl: drafts.webdav.webdavUrl,
    webdavUsername: drafts.webdav.webdavUsername,
    webdavPassword: drafts.webdav.webdavPassword,
    webdavPath: drafts.webdav.webdavPath,
    s3Endpoint: drafts.s3.s3Endpoint,
    s3Region: drafts.s3.s3Region,
    s3Bucket: drafts.s3.s3Bucket,
    s3Prefix: drafts.s3.s3Prefix,
    s3AddressingStyle: drafts.s3.s3AddressingStyle,
    s3AccessKeyId: drafts.s3.s3AccessKeyId,
    s3SecretAccessKey: drafts.s3.s3SecretAccessKey,
  };
}

function updateTestDraft(
  drafts: TestDraftByProvider,
  activeProvider: CloudBackupFormState["provider"],
  key: keyof CloudBackupFormState,
  value: CloudBackupFormState[keyof CloudBackupFormState],
): TestDraftByProvider {
  switch (key) {
    case "webdavUrl":
    case "webdavUsername":
    case "webdavPassword":
    case "webdavPath":
      return { ...drafts, webdav: { ...drafts.webdav, [key]: value as string } };
    case "s3Endpoint":
    case "s3Region":
    case "s3Bucket":
    case "s3Prefix":
    case "s3AccessKeyId":
    case "s3SecretAccessKey":
      return { ...drafts, s3: { ...drafts.s3, [key]: value as string } };
    case "scheduleEnabled":
    case "scheduleFrequency":
    case "scheduleTime":
    case "scheduleWeekday":
    case "retention":
      return { ...drafts, [activeProvider]: { ...drafts[activeProvider], [key]: value } };
    default:
      return drafts;
  }
}

export function snapshotFixture(patch: Partial<CloudBackupSnapshot> = {}): CloudBackupSnapshot {
  return {
    id: "snapshot-id",
    filename: "renewlet.zip",
    provider: "webdav",
    createdAt: "2026-06-09T08:00:00.000Z",
    sizeBytes: 1946,
    sha256: "a".repeat(64),
    ...patch,
  };
}

export function StatefulSection({ credentialSet = true }: { credentialSet?: boolean }) {
  const [provider, setProvider] = useState<CloudBackupFormState["provider"]>(defaultForm.provider);
  const [drafts, setDrafts] = useState<TestDraftByProvider>({
    webdav: createTestDraft("webdav", defaultPolicy),
    s3: createTestDraft("s3", s3Policy),
  });
  const credentialSetByProvider = { webdav: credentialSet, s3: false };
  const form = formFromTestDrafts(provider, drafts);
  const providerCredentialSet = credentialSetByProvider[provider];
  const controller = createController({
    form,
    credentialSet: providerCredentialSet,
    canCreateSnapshot: providerCredentialSet,
    config: readState({
      ...defaultConfigData(),
      credentialSet: providerCredentialSet,
      credentialSetByProvider,
      policyByProvider: { webdav: defaultPolicy, s3: s3Policy },
      statusByProvider: { webdav: webdavStatus, s3: s3Status },
      provider,
    }),
    updateForm: (key, value) => {
      if (key === "provider") {
        setProvider(value as CloudBackupFormState["provider"]);
        return;
      }
      setDrafts((previous) => updateTestDraft(previous, provider, key, value));
    },
  });
  return <CloudBackupSection controller={controller} />;
}

export function StatefulSnapshotSection({
  snapshots,
  restoreSnapshot,
  deleteSnapshot,
  isDownloading = false,
  isDeleting = false,
  restoringSnapshotKey = null,
  deletingSnapshotKey = null,
}: {
  snapshots: CloudBackupSnapshot[];
  restoreSnapshot: (snapshot: CloudBackupSnapshot) => Promise<void>;
  deleteSnapshot: (snapshot: CloudBackupSnapshot) => Promise<void>;
  isDownloading?: boolean;
  isDeleting?: boolean;
  restoringSnapshotKey?: string | null;
  deletingSnapshotKey?: string | null;
}) {
  const [provider, setProvider] = useState<CloudBackupFormState["provider"]>(defaultForm.provider);
  const [drafts, setDrafts] = useState<TestDraftByProvider>({
    webdav: createTestDraft("webdav", defaultPolicy),
    s3: createTestDraft("s3", s3Policy),
  });
  const credentialSetByProvider = { webdav: true, s3: true };
  const form = formFromTestDrafts(provider, drafts);
  const credentialSet = credentialSetByProvider[provider];
  const controller = createController({
    form,
    credentialSet,
    canCreateSnapshot: true,
    config: readState({
      ...defaultConfigData(),
      credentialSet,
      credentialSetByProvider,
      provider,
    }),
    snapshots: readState(snapshots.filter((snapshot) => snapshot.provider === provider)),
    isDownloading,
    isDeleting,
    restoringSnapshotKey,
    deletingSnapshotKey,
    restoreSnapshot,
    deleteSnapshot,
    updateForm: (key, value) => {
      if (key === "provider") {
        setProvider(value as CloudBackupFormState["provider"]);
        return;
      }
      setDrafts((previous) => updateTestDraft(previous, provider, key, value));
    },
  });
  return <CloudBackupSection controller={controller} />;
}
