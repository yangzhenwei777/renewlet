import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  useCloudBackupConfig,
  useCloudBackupSnapshots,
  useCreateCloudBackupSnapshot,
  useDeleteCloudBackupSnapshot,
  useDownloadCloudBackupSnapshot,
  useTestCloudBackup,
  useUpdateCloudBackupConfig,
} from "@/hooks/use-cloud-backup";
import {
  cloudBackupConfigUpdateSchema,
  CLOUD_BACKUP_DEFAULT_RETENTION,
  CLOUD_BACKUP_DEFAULT_SCHEDULE_TIME,
  CLOUD_BACKUP_DEFAULT_SCHEDULE_WEEKDAY,
  type CloudBackupConfig,
  type CloudBackupConfigUpdate,
  type CloudBackupProvider,
  type CloudBackupScheduleFrequency,
  type CloudBackupScheduleWeekday,
  type CloudBackupSnapshot,
} from "@/lib/api/schemas/cloud-backup";
import { toast } from "@/components/ui/sonner";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { useI18n } from "@/i18n/I18nProvider";
import { ApiError } from "@/lib/api-client";
import {
  createCloudBackupErrorDetails,
  extractCloudBackupErrorDetails,
  type CloudBackupErrorDetailsView,
} from "@/lib/cloud-backup-error-details";
import { getApiLocale } from "@/i18n/api-locale";
import { toSettingsReadState, type SettingsReadState } from "./settings-read-state";

export interface CloudBackupFormState {
  provider: CloudBackupProvider;
  webdavUrl: string;
  webdavUsername: string;
  webdavPassword: string;
  webdavPath: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3Prefix: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  scheduleEnabled: boolean;
  scheduleFrequency: CloudBackupScheduleFrequency;
  scheduleTime: string;
  scheduleWeekday: CloudBackupScheduleWeekday;
  retention: string;
}

export interface CloudBackupController {
  config: SettingsReadState<CloudBackupConfig>;
  snapshots: SettingsReadState<CloudBackupSnapshot[]>;
  isInitialLayoutReady: boolean;
  form: CloudBackupFormState;
  credentialSet: boolean;
  canCreateSnapshot: boolean;
  isSaving: boolean;
  isTesting: boolean;
  isCreating: boolean;
  isDownloading: boolean;
  isDeleting: boolean;
  restoringSnapshotKey: string | null;
  deletingSnapshotKey: string | null;
  hasUnsavedChanges: boolean;
  snapshotsErrorMessage: string | null;
  cloudBackupErrorDetails: CloudBackupErrorDetailsView | null;
  cloudBackupErrorDetailsOpen: boolean;
  setCloudBackupErrorDetailsOpen: (open: boolean) => void;
  openSnapshotsErrorDetails: () => void;
  updateForm: <K extends keyof CloudBackupFormState>(key: K, value: CloudBackupFormState[K]) => void;
  saveConfig: () => Promise<void>;
  testConfig: () => Promise<void>;
  createSnapshot: () => Promise<void>;
  restoreSnapshot: (snapshot: CloudBackupSnapshot) => Promise<void>;
  deleteSnapshot: (snapshot: CloudBackupSnapshot) => Promise<void>;
}

interface CloudBackupPolicyDraft {
  scheduleEnabled: boolean;
  scheduleFrequency: CloudBackupScheduleFrequency;
  scheduleTime: string;
  scheduleWeekday: CloudBackupScheduleWeekday;
  retention: string;
}

interface CloudBackupWebDavDraft extends CloudBackupPolicyDraft {
  webdavUrl: string;
  webdavUsername: string;
  webdavPassword: string;
  webdavPath: string;
}

interface CloudBackupS3Draft extends CloudBackupPolicyDraft {
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3Prefix: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
}

interface CloudBackupDraftByProvider {
  webdav: CloudBackupWebDavDraft;
  s3: CloudBackupS3Draft;
}

interface CloudBackupDraftState {
  activeProvider: CloudBackupProvider;
  draftByProvider: CloudBackupDraftByProvider;
  initializedFromConfig: boolean;
}

type CloudBackupProviderDraft = CloudBackupWebDavDraft | CloudBackupS3Draft;
type CloudBackupDraftSnapshotByProvider = Record<CloudBackupProvider, string>;

const CLOUD_BACKUP_PROVIDERS: CloudBackupProvider[] = ["webdav", "s3"];

const DEFAULT_POLICY_DRAFT: CloudBackupPolicyDraft = {
  scheduleEnabled: false,
  scheduleFrequency: "daily",
  scheduleTime: CLOUD_BACKUP_DEFAULT_SCHEDULE_TIME,
  scheduleWeekday: CLOUD_BACKUP_DEFAULT_SCHEDULE_WEEKDAY,
  retention: String(CLOUD_BACKUP_DEFAULT_RETENTION),
};

const DEFAULT_WEBDAV_DRAFT: CloudBackupWebDavDraft = {
  ...DEFAULT_POLICY_DRAFT,
  webdavUrl: "",
  webdavUsername: "",
  webdavPassword: "",
  webdavPath: "renewlet",
};

const DEFAULT_S3_DRAFT: CloudBackupS3Draft = {
  ...DEFAULT_POLICY_DRAFT,
  s3Endpoint: "",
  s3Region: "",
  s3Bucket: "",
  s3Prefix: "renewlet",
  s3AccessKeyId: "",
  s3SecretAccessKey: "",
};

export function useCloudBackupController(onRestoreFile: (file: File) => void): CloudBackupController {
  const { t } = useI18n();
  const configQuery = useCloudBackupConfig();
  const config = configQuery.data ?? null;
  const [draftState, setDraftState] = useState<CloudBackupDraftState>(() => ({
    activeProvider: "webdav",
    draftByProvider: createDefaultDraftByProvider(),
    initializedFromConfig: false,
  }));
  const { activeProvider, draftByProvider } = draftState;
  const form = useMemo(() => formFromDraftState(draftState), [draftState]);
  const credentialSet = config ? credentialSetForProvider(config, activeProvider) : false;
  const canCreateSnapshot = config ? hasSavedCloudBackupTargetForProvider(config, activeProvider) : false;
  const canQuerySnapshots = config ? hasSavedCloudBackupTargetForProvider(config, activeProvider) : false;
  const snapshotsQuery = useCloudBackupSnapshots({
    enabled: canQuerySnapshots,
    provider: activeProvider,
    configUpdatedAt: config?.statusByProvider[activeProvider].updatedAt ?? config?.updatedAt ?? null,
    locale: getApiLocale(),
  });
  const updateConfigMutation = useUpdateCloudBackupConfig();
  const testMutation = useTestCloudBackup();
  const createSnapshotMutation = useCreateCloudBackupSnapshot();
  const downloadSnapshotMutation = useDownloadCloudBackupSnapshot();
  const deleteSnapshotMutation = useDeleteCloudBackupSnapshot();
  const [restoringSnapshotKey, setRestoringSnapshotKey] = useState<string | null>(null);
  const [deletingSnapshotKey, setDeletingSnapshotKey] = useState<string | null>(null);
  const [cloudBackupErrorDetails, setCloudBackupErrorDetails] = useState<CloudBackupErrorDetailsView | null>(null);
  const [cloudBackupErrorDetailsOpen, setCloudBackupErrorDetailsOpen] = useState(false);
  const [savedDraftSnapshotByProvider, setSavedDraftSnapshotByProvider] = useState<CloudBackupDraftSnapshotByProvider>(() => stableDraftSnapshotByProvider(createDefaultDraftByProvider()));
  const savedDraftSnapshotByProviderRef = useRef(savedDraftSnapshotByProvider);

  const hasUnsavedChanges = useMemo(
    () => stableProviderDraftSnapshot(activeProvider, draftByProvider[activeProvider]) !== savedDraftSnapshotByProvider[activeProvider],
    [activeProvider, draftByProvider, savedDraftSnapshotByProvider],
  );
  const snapshotsErrorMessage = snapshotsQuery.error
    ? cloudBackupSnapshotsErrorMessage(snapshotsQuery.error, t("settings.cloudBackupSnapshotsLoadFailed"))
    : null;
  // 列表请求必须跟随当前 tab provider；只改 queryKey 不改 HTTP query 会让另一目标的上游错误串到当前页。
  const visibleSnapshots = useMemo(
    () => (snapshotsQuery.data ?? []).filter((snapshot) => snapshot.provider === activeProvider),
    [activeProvider, snapshotsQuery.data],
  );
  const configReadState = toSettingsReadState(configQuery);
  const snapshotsReadState = {
    ...toSettingsReadState(snapshotsQuery),
    data: canQuerySnapshots
      ? snapshotsQuery.data === undefined ? undefined : visibleSnapshots
      : [],
    hasData: !canQuerySnapshots || snapshotsQuery.data !== undefined,
  } satisfies SettingsReadState<CloudBackupSnapshot[]>;
  // config success 早于草稿同步，快照查询又可能在 provider 就绪后才启动；三者都稳定后完整表单几何才可用于目录定位。
  const isInitialLayoutReady = !configReadState.isInitialLoading
    && (!configReadState.hasData || draftState.initializedFromConfig)
    && !snapshotsReadState.isInitialLoading;

  const openCloudBackupErrorDetails = useCallback((error: unknown, fallbackMessage: string) => {
    const extracted = extractCloudBackupErrorDetails(error);
    const details = extracted ?? createCloudBackupErrorDetails(error, fallbackMessage);
    setCloudBackupErrorDetails(details);
    setCloudBackupErrorDetailsOpen(true);
  }, []);

  const openSnapshotsErrorDetails = useCallback(() => {
    if (!snapshotsQuery.error) return;
    openCloudBackupErrorDetails(snapshotsQuery.error, t("settings.cloudBackupSnapshotsLoadFailed"));
  }, [openCloudBackupErrorDetails, snapshotsQuery.error, t]);

  useEffect(() => {
    if (!configQuery.data) return;
    setDraftState((previous) => {
      const synced = syncDraftStateFromConfig(previous, configQuery.data, savedDraftSnapshotByProviderRef.current);
      savedDraftSnapshotByProviderRef.current = synced.savedSnapshots;
      // 保存态快照参与 dirty 渲染判断，同时保留 ref 给异步 config 同步读取最新边界。
      setSavedDraftSnapshotByProvider(synced.savedSnapshots);
      return synced.state;
    });
  }, [configQuery.data]);

  const updateForm = useCallback(<K extends keyof CloudBackupFormState>(key: K, value: CloudBackupFormState[K]) => {
    setDraftState((previous) => {
      if (key === "provider") {
        return { ...previous, activeProvider: value as CloudBackupProvider };
      }
      return {
        ...previous,
        draftByProvider: updateDraftByField(previous.draftByProvider, previous.activeProvider, key, value),
      };
    });
  }, []);

  const parsePayload = useCallback((): CloudBackupConfigUpdate => {
    try {
      return cloudBackupConfigUpdateSchema.parse(formToPayload(activeProvider, draftByProvider[activeProvider]));
    } catch (error) {
      const description = error instanceof z.ZodError
        ? t("settings.cloudBackupInvalidDescription")
        : getDisplayErrorMessage(error, t("settings.cloudBackupInvalidDescription"));
      toast.error(t("settings.cloudBackupInvalid"), { description });
      throw error;
    }
  }, [activeProvider, draftByProvider, t]);

  const saveConfig = useCallback(async () => {
    try {
      const payload = parsePayload();
      const saved = await updateConfigMutation.mutateAsync(payload);
      setDraftState((previous) => {
        const synced = syncDraftStateFromConfig(previous, saved, savedDraftSnapshotByProviderRef.current, { forceProvider: payload.provider });
        savedDraftSnapshotByProviderRef.current = synced.savedSnapshots;
        setSavedDraftSnapshotByProvider(synced.savedSnapshots);
        return synced.state;
      });
      toast.success(credentialSetForProvider(saved, payload.provider)
          ? t("settings.cloudBackupSavedWithCredential")
          : t("settings.cloudBackupSaved"));
    } catch (error) {
      if (error instanceof z.ZodError) return;
      toast.error(t("settings.cloudBackupSaveFailed"), {
        description: getDisplayErrorMessage(error, t("settings.cloudBackupSaveFailedDescription")),
      });
    }
  }, [parsePayload, t, updateConfigMutation]);

  const testConfig = useCallback(async () => {
    try {
      await testMutation.mutateAsync(parsePayload());
      toast.success(t("settings.cloudBackupTestSucceeded"));
    } catch (error) {
      if (error instanceof z.ZodError) return;
      toast.error(t("settings.cloudBackupTestFailed"), {
        description: getDisplayErrorMessage(error, t("settings.cloudBackupTestFailedDescription")),
      });
      openCloudBackupErrorDetails(error, t("settings.cloudBackupTestFailedDescription"));
    }
  }, [openCloudBackupErrorDetails, parsePayload, t, testMutation]);

  const createSnapshot = useCallback(async () => {
    try {
      await createSnapshotMutation.mutateAsync({ provider: activeProvider });
      toast.success(t("settings.cloudBackupCreated"));
    } catch (error) {
      toast.error(t("settings.cloudBackupCreateFailed"), {
        description: getDisplayErrorMessage(error, t("settings.cloudBackupCreateFailedDescription")),
      });
      openCloudBackupErrorDetails(error, t("settings.cloudBackupCreateFailedDescription"));
    }
  }, [activeProvider, createSnapshotMutation, openCloudBackupErrorDetails, t]);

  const restoreSnapshot = useCallback(async (snapshot: CloudBackupSnapshot) => {
    // 恢复 loading 必须绑定 provider:id；WebDAV/S3 可以出现同名快照 id，不能只用 id 标记行状态。
    setRestoringSnapshotKey(cloudBackupSnapshotKey(snapshot));
    try {
      const blob = await downloadSnapshotMutation.mutateAsync(snapshot);
      // 云快照恢复只能把 ZIP 交给现有导入预览；导入 apply 前仍由用户确认 create/replace/skip。
      onRestoreFile(new File([blob], snapshot.filename, { type: "application/zip" }));
      toast.success(t("settings.cloudBackupRestoreReadyResult"));
    } catch (error) {
      toast.error(t("settings.cloudBackupRestoreFailed"), {
        description: getDisplayErrorMessage(error, t("settings.cloudBackupRestoreFailedDescription")),
      });
      openCloudBackupErrorDetails(error, t("settings.cloudBackupRestoreFailedDescription"));
    } finally {
      setRestoringSnapshotKey(null);
    }
  }, [downloadSnapshotMutation, onRestoreFile, openCloudBackupErrorDetails, t]);

  const deleteSnapshot = useCallback(async (snapshot: CloudBackupSnapshot) => {
    // 删除 mutation 也是全局单操作；行级 UI 必须绑定 provider:id，避免 WebDAV/S3 同名快照串 loading。
    setDeletingSnapshotKey(cloudBackupSnapshotKey(snapshot));
    try {
      await deleteSnapshotMutation.mutateAsync(snapshot);
      toast.success(t("settings.cloudBackupDeleted"));
    } catch (error) {
      toast.error(t("settings.cloudBackupDeleteFailed"), {
        description: getDisplayErrorMessage(error, t("settings.cloudBackupDeleteFailedDescription")),
      });
      openCloudBackupErrorDetails(error, t("settings.cloudBackupDeleteFailedDescription"));
    } finally {
      setDeletingSnapshotKey(null);
    }
  }, [deleteSnapshotMutation, openCloudBackupErrorDetails, t]);

  return {
    config: configReadState,
    snapshots: snapshotsReadState,
    isInitialLayoutReady,
    form,
    credentialSet,
    canCreateSnapshot,
    isSaving: updateConfigMutation.isPending,
    isTesting: testMutation.isPending,
    isCreating: createSnapshotMutation.isPending,
    isDownloading: downloadSnapshotMutation.isPending,
    isDeleting: deleteSnapshotMutation.isPending,
    restoringSnapshotKey,
    deletingSnapshotKey,
    hasUnsavedChanges,
    snapshotsErrorMessage,
    cloudBackupErrorDetails,
    cloudBackupErrorDetailsOpen,
    setCloudBackupErrorDetailsOpen,
    openSnapshotsErrorDetails,
    updateForm,
    saveConfig,
    testConfig,
    createSnapshot,
    restoreSnapshot,
    deleteSnapshot,
  };
}

function cloudBackupSnapshotKey(snapshot: CloudBackupSnapshot): string {
  return `${snapshot.provider}:${snapshot.id}`;
}

function createDefaultDraftByProvider(): CloudBackupDraftByProvider {
  return {
    webdav: { ...DEFAULT_WEBDAV_DRAFT },
    s3: { ...DEFAULT_S3_DRAFT },
  };
}

function formFromDraftState(state: CloudBackupDraftState): CloudBackupFormState {
  const { activeProvider, draftByProvider } = state;
  const activeDraft = draftByProvider[activeProvider];
  return {
    provider: activeProvider,
    webdavUrl: draftByProvider.webdav.webdavUrl,
    webdavUsername: draftByProvider.webdav.webdavUsername,
    webdavPassword: draftByProvider.webdav.webdavPassword,
    webdavPath: draftByProvider.webdav.webdavPath,
    s3Endpoint: draftByProvider.s3.s3Endpoint,
    s3Region: draftByProvider.s3.s3Region,
    s3Bucket: draftByProvider.s3.s3Bucket,
    s3Prefix: draftByProvider.s3.s3Prefix,
    s3AccessKeyId: draftByProvider.s3.s3AccessKeyId,
    s3SecretAccessKey: draftByProvider.s3.s3SecretAccessKey,
    scheduleEnabled: activeDraft.scheduleEnabled,
    scheduleFrequency: activeDraft.scheduleFrequency,
    scheduleTime: activeDraft.scheduleTime,
    scheduleWeekday: activeDraft.scheduleWeekday,
    retention: activeDraft.retention,
  };
}

function draftByProviderFromConfig(config: CloudBackupConfig): CloudBackupDraftByProvider {
  return {
    webdav: webdavDraftFromConfig(config),
    s3: s3DraftFromConfig(config),
  };
}

function webdavDraftFromConfig(config: CloudBackupConfig): CloudBackupWebDavDraft {
  const policy = config.policyByProvider.webdav;
  return {
    scheduleEnabled: policy.scheduleEnabled,
    scheduleFrequency: policy.scheduleFrequency,
    scheduleTime: policy.scheduleTime,
    scheduleWeekday: policy.scheduleWeekday,
    retention: String(policy.retention),
    webdavUrl: config.webdav?.url ?? "",
    webdavUsername: config.webdav?.username ?? "",
    webdavPassword: "",
    webdavPath: config.webdav?.path ?? "renewlet",
  };
}

function s3DraftFromConfig(config: CloudBackupConfig): CloudBackupS3Draft {
  const policy = config.policyByProvider.s3;
  return {
    scheduleEnabled: policy.scheduleEnabled,
    scheduleFrequency: policy.scheduleFrequency,
    scheduleTime: policy.scheduleTime,
    scheduleWeekday: policy.scheduleWeekday,
    retention: String(policy.retention),
    s3Endpoint: config.s3?.endpoint ?? "",
    s3Region: config.s3?.region ?? "",
    s3Bucket: config.s3?.bucket ?? "",
    s3Prefix: config.s3?.prefix ?? "renewlet",
    s3AccessKeyId: config.s3?.accessKeyId ?? "",
    s3SecretAccessKey: "",
  };
}

function syncDraftStateFromConfig(
  previous: CloudBackupDraftState,
  config: CloudBackupConfig,
  savedSnapshots: CloudBackupDraftSnapshotByProvider,
  options: { forceProvider?: CloudBackupProvider } = {},
): { state: CloudBackupDraftState; savedSnapshots: CloudBackupDraftSnapshotByProvider } {
  const nextDraftByProviderFromConfig = draftByProviderFromConfig(config);
  const nextSavedSnapshots = stableDraftSnapshotByProvider(nextDraftByProviderFromConfig);
  const nextDraftByProvider = createDefaultDraftByProvider();
  const hadLocalDraft = CLOUD_BACKUP_PROVIDERS.some((provider) => {
    const currentDraft = previous.draftByProvider[provider];
    return stableProviderDraftSnapshot(provider, currentDraft) !== savedSnapshots[provider] || providerDraftHasPendingSecret(provider, currentDraft);
  });

  for (const provider of CLOUD_BACKUP_PROVIDERS) {
    const currentDraft = previous.draftByProvider[provider];
    const hasLocalDraft = stableProviderDraftSnapshot(provider, currentDraft) !== savedSnapshots[provider] || providerDraftHasPendingSecret(provider, currentDraft);
    // provider tab 是云备份编辑草稿的隔离边界；write-only secret 和策略都不能被另一个目标的 refetch/save 顺手覆盖。
    if (provider === "webdav") {
      nextDraftByProvider.webdav = provider !== options.forceProvider && hasLocalDraft
        ? previous.draftByProvider.webdav
        : nextDraftByProviderFromConfig.webdav;
    } else {
      nextDraftByProvider.s3 = provider !== options.forceProvider && hasLocalDraft
        ? previous.draftByProvider.s3
        : nextDraftByProviderFromConfig.s3;
    }
  }

  return {
    state: {
      activeProvider: previous.initializedFromConfig || hadLocalDraft ? previous.activeProvider : config.provider,
      draftByProvider: nextDraftByProvider,
      initializedFromConfig: true,
    },
    savedSnapshots: nextSavedSnapshots,
  };
}

function formToPayload(provider: CloudBackupProvider, draft: CloudBackupProviderDraft): unknown {
  const retention = Number.parseInt(draft.retention, 10);
  const policy = {
    scheduleEnabled: draft.scheduleEnabled,
    scheduleFrequency: draft.scheduleFrequency,
    scheduleTime: draft.scheduleTime,
    scheduleWeekday: draft.scheduleWeekday,
    retention: Number.isInteger(retention) ? retention : 0,
  };
  if (provider === "webdav") {
    const webdavDraft = draft as CloudBackupWebDavDraft;
    return {
      provider,
      webdav: {
        url: webdavDraft.webdavUrl,
        username: webdavDraft.webdavUsername,
        path: webdavDraft.webdavPath,
      },
      credentials: webdavDraft.webdavPassword.trim() ? { webdavPassword: webdavDraft.webdavPassword } : {},
      policy,
    };
  }
  const s3Draft = draft as CloudBackupS3Draft;
  return {
    provider,
    s3: {
      endpoint: s3Draft.s3Endpoint,
      region: s3Draft.s3Region,
      bucket: s3Draft.s3Bucket,
      prefix: s3Draft.s3Prefix,
      accessKeyId: s3Draft.s3AccessKeyId,
    },
    credentials: s3Draft.s3SecretAccessKey.trim() ? { s3SecretAccessKey: s3Draft.s3SecretAccessKey } : {},
    policy,
  };
}

function updateDraftByField<K extends keyof CloudBackupFormState>(
  draftByProvider: CloudBackupDraftByProvider,
  activeProvider: CloudBackupProvider,
  key: K,
  value: CloudBackupFormState[K],
): CloudBackupDraftByProvider {
  switch (key) {
    case "webdavUrl":
    case "webdavUsername":
    case "webdavPassword":
    case "webdavPath":
      return {
        ...draftByProvider,
        webdav: { ...draftByProvider.webdav, [key]: value as string },
      };
    case "s3Endpoint":
    case "s3Region":
    case "s3Bucket":
    case "s3Prefix":
    case "s3AccessKeyId":
    case "s3SecretAccessKey":
      return {
        ...draftByProvider,
        s3: { ...draftByProvider.s3, [key]: value as string },
      };
    case "scheduleEnabled":
      return updateActivePolicyDraft(draftByProvider, activeProvider, { scheduleEnabled: value as boolean });
    case "scheduleFrequency":
      return updateActivePolicyDraft(draftByProvider, activeProvider, { scheduleFrequency: value as CloudBackupScheduleFrequency });
    case "scheduleTime":
      return updateActivePolicyDraft(draftByProvider, activeProvider, { scheduleTime: value as string });
    case "scheduleWeekday":
      return updateActivePolicyDraft(draftByProvider, activeProvider, { scheduleWeekday: value as CloudBackupScheduleWeekday });
    case "retention":
      return updateActivePolicyDraft(draftByProvider, activeProvider, { retention: value as string });
    default:
      return draftByProvider;
  }
}

function updateActivePolicyDraft(
  draftByProvider: CloudBackupDraftByProvider,
  activeProvider: CloudBackupProvider,
  patch: Partial<CloudBackupPolicyDraft>,
): CloudBackupDraftByProvider {
  if (activeProvider === "webdav") {
    return {
      ...draftByProvider,
      webdav: { ...draftByProvider.webdav, ...patch },
    };
  }
  return {
    ...draftByProvider,
    s3: { ...draftByProvider.s3, ...patch },
  };
}

function credentialSetForProvider(config: CloudBackupConfig, provider: CloudBackupProvider): boolean {
  return config.credentialSetByProvider[provider] ?? false;
}

function cloudBackupSnapshotsErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.code === "CLOUD_BACKUP_LIST_FAILED") return fallback;
  return getDisplayErrorMessage(error, fallback);
}

function hasSavedCloudBackupTargetForProvider(config: CloudBackupConfig, provider: CloudBackupProvider): boolean {
  if (provider === "webdav") return Boolean(config.webdav && config.credentialSetByProvider.webdav);
  return Boolean(config.s3 && config.s3.accessKeyId.trim() && config.credentialSetByProvider.s3);
}

function stableDraftSnapshotByProvider(draftByProvider: CloudBackupDraftByProvider): CloudBackupDraftSnapshotByProvider {
  return {
    webdav: stableProviderDraftSnapshot("webdav", draftByProvider.webdav),
    s3: stableProviderDraftSnapshot("s3", draftByProvider.s3),
  };
}

function stableProviderDraftSnapshot(provider: CloudBackupProvider, draft: CloudBackupProviderDraft): string {
  if (provider === "webdav") {
    const webdavDraft = draft as CloudBackupWebDavDraft;
    return JSON.stringify({
      webdavUrl: webdavDraft.webdavUrl,
      webdavUsername: webdavDraft.webdavUsername,
      webdavPath: webdavDraft.webdavPath,
      scheduleEnabled: webdavDraft.scheduleEnabled,
      scheduleFrequency: webdavDraft.scheduleFrequency,
      scheduleTime: webdavDraft.scheduleTime,
      scheduleWeekday: webdavDraft.scheduleWeekday,
      retention: webdavDraft.retention,
    });
  }
  const s3Draft = draft as CloudBackupS3Draft;
  return JSON.stringify({
    s3Endpoint: s3Draft.s3Endpoint,
    s3Region: s3Draft.s3Region,
    s3Bucket: s3Draft.s3Bucket,
    s3Prefix: s3Draft.s3Prefix,
    s3AccessKeyId: s3Draft.s3AccessKeyId,
    scheduleEnabled: s3Draft.scheduleEnabled,
    scheduleFrequency: s3Draft.scheduleFrequency,
    scheduleTime: s3Draft.scheduleTime,
    scheduleWeekday: s3Draft.scheduleWeekday,
    retention: s3Draft.retention,
  });
}

function providerDraftHasPendingSecret(provider: CloudBackupProvider, draft: CloudBackupProviderDraft): boolean {
  if (provider === "webdav") return (draft as CloudBackupWebDavDraft).webdavPassword.trim() !== "";
  return (draft as CloudBackupS3Draft).s3SecretAccessKey.trim() !== "";
}
