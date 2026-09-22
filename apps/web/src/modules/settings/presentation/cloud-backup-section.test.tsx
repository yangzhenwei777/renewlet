import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudBackupSection } from "./cloud-backup-section";
import type { CloudBackupController, CloudBackupFormState } from "../application/use-cloud-backup-controller";
import type { CloudBackupConfig, CloudBackupPolicy, CloudBackupSnapshot } from "@/lib/api/schemas/cloud-backup";
import type { SettingsReadState } from "../application/settings-read-state";
vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        "common.cancel": "取消",
        "common.close": "关闭",
        "common.delete": "删除",
        "common.loading": "加载中",
        "common.saving": "保存中",
        "time.hour": "时",
        "time.minute": "分",
        "settings.cloudBackup": "云同步与备份",
        "settings.cloudBackupHelp": "保存可恢复云端快照；恢复时会进入导入预览，不会自动覆盖数据。",
        "settings.cloudBackupSummary": "{provider} · {credential} · {status}",
        "settings.statusUnknown": "状态未知",
        "settings.notUpdated": "未更新",
        "settings.managerLoadFailed": "加载失败",
        "settings.managerRefreshFailed": "未更新",
        "settings.managerRetry": "重试",
        "settings.cloudBackupStatusIdle": "未运行",
        "settings.cloudBackupStatusSuccess": "上次成功",
        "settings.cloudBackupStatusFailed": "上次失败",
        "settings.cloudBackupCredentialSaved": "已保存密钥",
        "settings.cloudBackupCredentialMissing": "未保存密钥",
        "settings.cloudBackupStatusActions": "状态与操作",
        "settings.cloudBackupProvider": "存储类型",
        "settings.cloudBackupCredential": "密钥",
        "settings.cloudBackupLastStatus": "上次状态",
        "settings.cloudBackupLastBackupAt": "上次备份",
        "settings.cloudBackupNeverBackedUp": "从未备份",
        "settings.cloudBackupConnection": "连接配置",
        "settings.cloudBackupPolicy": "备份策略",
        "settings.cloudBackupProviderWebdav": "WebDAV",
        "settings.cloudBackupProviderS3": "S3 兼容存储",
        "settings.cloudBackupWebdavUrl": "WebDAV 地址",
        "settings.cloudBackupWebdavUsername": "用户名",
        "settings.cloudBackupWebdavPassword": "密码",
        "settings.cloudBackupWebdavPath": "远端路径",
        "settings.cloudBackupS3Endpoint": "Endpoint",
        "settings.cloudBackupS3Region": "Region",
        "settings.cloudBackupS3RegionHelp": "必填；按存储服务商 S3 API 文档填写 signing region，R2/Tigris 通常为 auto。",
        "settings.cloudBackupS3Bucket": "Bucket",
        "settings.cloudBackupS3Prefix": "Prefix",
        "settings.cloudBackupS3AccessKey": "Access Key",
        "settings.cloudBackupS3Secret": "Secret Key",
        "settings.cloudBackupPathHelp": "只填写目录前缀，不要包含 .. 或文件名。",
        "settings.cloudBackupSecretPlaceholder": "保存后不再回显",
        "settings.cloudBackupSecretPlaceholderSaved": "留空保留已保存密钥",
        "settings.cloudBackupSchedule": "定时自动备份",
        "settings.cloudBackupScheduleHelp": "默认关闭；开启后由服务端定时生成快照并按保留数量清理旧快照。",
        "settings.cloudBackupFrequency": "频率",
        "settings.cloudBackupFrequencyDaily": "每天",
        "settings.cloudBackupFrequencyWeekly": "每周",
        "settings.cloudBackupScheduleTime": "执行时间",
        "settings.cloudBackupScheduleWeekday": "星期",
        "settings.cloudBackupWeekdayMonday": "星期一",
        "settings.cloudBackupWeekdayTuesday": "星期二",
        "settings.cloudBackupWeekdayWednesday": "星期三",
        "settings.cloudBackupWeekdayThursday": "星期四",
        "settings.cloudBackupWeekdayFriday": "星期五",
        "settings.cloudBackupWeekdaySaturday": "星期六",
        "settings.cloudBackupWeekdaySunday": "星期日",
        "settings.cloudBackupRetention": "保留数量",
        "settings.cloudBackupSave": "保存配置",
        "settings.cloudBackupSaveAgain": "保存配置",
        "settings.cloudBackupTest": "测试连接",
        "settings.cloudBackupTesting": "测试中...",
        "settings.cloudBackupCreateNow": "立即备份",
        "settings.cloudBackupCreating": "备份中...",
        "settings.cloudBackupSnapshots": "云端快照",
        "settings.cloudBackupSnapshotsHelp": "快照下载前会校验 manifest 与 SHA-256；恢复仍需在导入预览中确认。",
        "settings.cloudBackupSnapshotsLoadFailed": "云端快照列表加载失败",
        "settings.cloudBackupRefresh": "刷新",
        "settings.cloudBackupSnapshotsEmpty": "暂无云端快照。",
        "settings.cloudBackupRestore": "恢复",
        "settings.cloudBackupRestoring": "恢复中...",
        "settings.cloudBackupDeleting": "删除中...",
        "settings.cloudBackupRestoreNamed": "恢复「{name}」",
        "settings.cloudBackupRestoringNamed": "正在恢复「{name}」",
        "settings.cloudBackupDeleteNamed": "删除「{name}」",
        "settings.cloudBackupDeletingNamed": "正在删除「{name}」",
        "settings.cloudBackupDeleteTitle": "删除「{name}」？",
        "settings.cloudBackupDeleteDescription": "该操作会删除远端 ZIP 和 manifest，删除后无法通过 Renewlet 恢复。",
        "settings.cloudBackupUpstreamTitle": "云存储错误详情",
        "settings.cloudBackupUpstreamDescription": "接口返回的原始响应。",
        "settings.cloudBackupUpstreamOpen": "查看错误详情",
        "rawErrorResponse.copy": "复制错误详情",
        "rawErrorResponse.copied": "已复制",
        "rawErrorResponse.copyFailed": "复制失败",
        "rawErrorResponse.responseUnavailable": "当前错误没有可回显的响应正文。",
      };
      const message = messages[key] ?? key;
      if (!params) return message;
      return message.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
    },
    formatDateTime: () => "2026-06-09 08:00",
  }),
}));
function installPointerCaptureMocks() {
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

function readState<T>(data: T | undefined, overrides: Partial<SettingsReadState<T>> = {}): SettingsReadState<T> {
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

function createController(overrides: Partial<CloudBackupController> = {}): CloudBackupController {
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

function snapshotFixture(patch: Partial<CloudBackupSnapshot> = {}): CloudBackupSnapshot {
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

function StatefulSection({ credentialSet = true }: { credentialSet?: boolean }) {
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

function StatefulSnapshotSection({
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

describe("CloudBackupSection", () => {
  beforeEach(() => {
    installPointerCaptureMocks();
  });

  it("does not render empty default configuration when the first config read fails", async () => {
    const user = userEvent.setup();
    const retry = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    render(<CloudBackupSection controller={createController({
      config: readState<CloudBackupConfig>(undefined, {
        error: new Error("config unavailable"),
        retry,
      }),
    })} />);

    expect(screen.getByText("状态未知")).toBeInTheDocument();
    expect(screen.getByText("加载失败")).toBeInTheDocument();
    expect(screen.queryByLabelText("WebDAV 地址")).not.toBeInTheDocument();
    expect(screen.queryByText("未保存密钥")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("switches provider forms and keeps saved credentials write-only", async () => {
    const user = userEvent.setup();
    render(<StatefulSection credentialSet />);

    expect(screen.getByRole("heading", { name: "云同步与备份" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "状态与操作" })).toBeInTheDocument();
    expect(screen.getByLabelText("密码")).toHaveAttribute("placeholder", "留空保留已保存密钥");
    expect(screen.getAllByText("上次成功")).toHaveLength(1);
    expect(screen.getAllByText("已保存密钥")).toHaveLength(1);
    expect(screen.getByText("2026-06-09 08:00")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "执行时间" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "时" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "分" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /执行时间/ })).toHaveTextContent("03:00");
  expect(screen.getByRole("button", { name: /执行时间/ })).toBeDisabled();
  expect(screen.queryByLabelText("星期")).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "S3 兼容存储" }));

    expect(screen.getByLabelText("Endpoint")).toBeInTheDocument();
    expect(screen.queryByLabelText("地址模式")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Secret Key")).toHaveAttribute("placeholder", "保存后不再回显");
    expect(screen.getAllByText("上次失败")).toHaveLength(1);
    expect(screen.getAllByText("未保存密钥")).toHaveLength(1);
    expect(screen.getByText("从未备份")).toBeInTheDocument();
    expect(screen.getByText("S3 权限不足")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /执行时间/ })).toHaveTextContent("04:30");
    expect(screen.getByRole("button", { name: /执行时间/ })).toBeEnabled();
    const retentionInput = screen.getByLabelText("保留数量") as HTMLInputElement;
    expect(retentionInput).toHaveAttribute("type", "text");
    expect(retentionInput).toHaveAttribute("inputmode", "numeric");
    expect(screen.queryByRole("spinbutton", { name: "保留数量" })).not.toBeInTheDocument();
  expect(retentionInput).toHaveValue("9");
  await user.clear(retentionInput);
  expect(retentionInput).toHaveValue("");
    await user.type(retentionInput, "30");
    expect(retentionInput).toHaveValue("30");
    await user.clear(retentionInput);
    await user.type(retentionInput, "0");
    expect(retentionInput).toHaveValue("");
    await user.type(retentionInput, "31");
    expect(retentionInput).toHaveValue("3");
    await user.clear(retentionInput);
    await user.type(retentionInput, "-1.5e3");
    expect(retentionInput.value).not.toMatch(/[.\-eE]/);
    const weekdayLabel = screen.getByText("星期", { selector: "label" });
    const scheduleTimeLabel = screen.getByText("执行时间", { selector: "label" });
  expect(weekdayLabel.compareDocumentPosition(scheduleTimeLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /执行时间/ }));
    const hourColumn = await screen.findByRole("spinbutton", { name: "时" });
    const minuteColumn = await screen.findByRole("spinbutton", { name: "分" });
    expect(within(hourColumn).getByText("23")).toBeInTheDocument();
    expect(within(hourColumn).queryByText("24")).not.toBeInTheDocument();
    expect(within(hourColumn).queryByText("25")).not.toBeInTheDocument();
    expect(within(minuteColumn).getByText("59")).toBeInTheDocument();
    await user.click(within(hourColumn).getByText("23"));
    expect(screen.getByRole("button", { name: /执行时间/ })).toHaveTextContent("23:30");
    await user.click(within(minuteColumn).getByText("59"));
    expect(screen.getByRole("button", { name: /执行时间/ })).toHaveTextContent("23:59");
  });

  it("requires credentials before creating snapshots and routes restore through the controller", async () => {
    const user = userEvent.setup();
    const snapshot = snapshotFixture({
      id: "renewlet-export-v1-20260609T000000Z-abcd1234",
      filename: "renewlet-export-v1-20260609T000000Z-abcd1234.zip",
      createdAt: "2026-06-09T00:00:00.000Z",
      sizeBytes: 1024,
    });
    const restoreSnapshot = vi.fn(async () => undefined);
    const controller = createController({
      snapshots: readState([snapshot]),
      restoreSnapshot,
    });

    const { rerender } = render(<StatefulSection credentialSet={false} />);
    expect(screen.getByRole("button", { name: "立即备份" })).toBeDisabled();

    rerender(<CloudBackupSection controller={controller} />);
    expect(screen.getAllByText("WebDAV").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "恢复「renewlet-export-v1-20260609T000000Z-abcd1234.zip」" }));

    expect(restoreSnapshot).toHaveBeenCalledWith(snapshot);
  });

  it("shows only snapshots for the selected provider and keeps row actions scoped", async () => {
    const user = userEvent.setup();
    const webdavSnapshot = snapshotFixture({
      id: "renewlet-export-v1-20260609T080000Z-webdav",
      filename: "renewlet-webdav.zip",
      sha256: "b".repeat(64),
    });
    const s3Snapshot = snapshotFixture({
      id: "renewlet-export-v1-20260609T081000Z-s3",
      filename: "renewlet-s3.zip",
      provider: "s3",
      createdAt: "2026-06-09T08:10:00.000Z",
      sizeBytes: 2048,
      sha256: "c".repeat(64),
    });
    const restoreSnapshot = vi.fn(async () => undefined);
    const deleteSnapshot = vi.fn(async () => undefined);
    render(
      <StatefulSnapshotSection
        snapshots={[webdavSnapshot, s3Snapshot]}
        restoreSnapshot={restoreSnapshot}
        deleteSnapshot={deleteSnapshot}
      />,
    );

    expect(screen.getByText("renewlet-webdav.zip")).toBeInTheDocument();
    expect(screen.getByText("1.9 KiB")).toBeInTheDocument();
    expect(screen.queryByText("renewlet-s3.zip")).not.toBeInTheDocument();
    expect(screen.queryByText("2.0 KiB")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复「renewlet-webdav.zip」" })).toHaveTextContent("恢复");
    expect(screen.getByRole("button", { name: "删除「renewlet-webdav.zip」" })).toHaveTextContent("删除");

    await user.click(screen.getByRole("tab", { name: "S3 兼容存储" }));
    expect(screen.getByText("renewlet-s3.zip")).toBeInTheDocument();
    expect(screen.getByText("2.0 KiB")).toBeInTheDocument();
    expect(screen.queryByText("renewlet-webdav.zip")).not.toBeInTheDocument();
    expect(screen.queryByText("1.9 KiB")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "恢复「renewlet-s3.zip」" }));
    expect(restoreSnapshot).toHaveBeenCalledWith(s3Snapshot);

    await user.click(screen.getByRole("button", { name: "删除「renewlet-s3.zip」" }));
    const dialog = screen.getByRole("alertdialog", { name: "删除「renewlet-s3.zip」？" });
    await user.click(within(dialog).getByRole("button", { name: "删除" }));
    expect(deleteSnapshot).toHaveBeenCalledWith(s3Snapshot);
    expect(screen.getByRole("heading", { name: "云端快照" })).toHaveFocus();
  });

  it("shows restoring loading state only on the matching snapshot row", () => {
    const restoringSnapshot = snapshotFixture({
      id: "shared-snapshot-id",
      filename: "renewlet-webdav.zip",
      sha256: "d".repeat(64),
    });
    const idleSnapshot = snapshotFixture({
      id: "idle-snapshot-id",
      filename: "renewlet-webdav-idle.zip",
      createdAt: "2026-06-09T08:10:00.000Z",
      sizeBytes: 2048,
      sha256: "e".repeat(64),
    });

    render(<CloudBackupSection controller={createController({
      snapshots: readState([restoringSnapshot, idleSnapshot]),
      isDownloading: true,
      restoringSnapshotKey: "webdav:shared-snapshot-id",
    })} />);

    const restoringRow = screen.getByText("renewlet-webdav.zip").closest("div.grid");
    expect(restoringRow).not.toBeNull();
    expect(within(restoringRow as HTMLElement).getByRole("button", { name: "正在恢复「renewlet-webdav.zip」" })).toHaveAttribute("aria-busy", "true");

    const idleRow = screen.getByText("renewlet-webdav-idle.zip").closest("div.grid");
    expect(idleRow).not.toBeNull();
    const idleScope = within(idleRow as HTMLElement);
    expect(idleScope.queryByRole("button", { name: "正在恢复「renewlet-webdav-idle.zip」" })).not.toBeInTheDocument();
    expect(idleScope.getByRole("button", { name: "恢复「renewlet-webdav-idle.zip」" })).toBeDisabled();
    expect(idleScope.getByRole("button", { name: "删除「renewlet-webdav-idle.zip」" })).toBeDisabled();
  });

  it("shows deleting loading state only on the matching snapshot row", () => {
    const deletingSnapshot = snapshotFixture({
      id: "deleting-snapshot-id",
      filename: "renewlet-webdav.zip",
      sha256: "d".repeat(64),
    });
    const idleSnapshot = snapshotFixture({
      id: "idle-snapshot-id",
      filename: "renewlet-webdav-idle.zip",
      createdAt: "2026-06-09T08:10:00.000Z",
      sizeBytes: 2048,
      sha256: "e".repeat(64),
    });

    render(<CloudBackupSection controller={createController({
      snapshots: readState([deletingSnapshot, idleSnapshot]),
      isDeleting: true,
      deletingSnapshotKey: "webdav:deleting-snapshot-id",
    })} />);

    const deletingRow = screen.getByText("renewlet-webdav.zip").closest("div.grid");
    expect(deletingRow).not.toBeNull();
    expect(within(deletingRow as HTMLElement).getByRole("button", { name: "正在删除「renewlet-webdav.zip」" })).toHaveAttribute("aria-busy", "true");

    const idleRow = screen.getByText("renewlet-webdav-idle.zip").closest("div.grid");
    expect(idleRow).not.toBeNull();
    const idleScope = within(idleRow as HTMLElement);
    expect(idleScope.queryByRole("button", { name: "正在删除「renewlet-webdav-idle.zip」" })).not.toBeInTheDocument();
    expect(idleScope.getByRole("button", { name: "恢复「renewlet-webdav-idle.zip」" })).toBeDisabled();
    expect(idleScope.getByRole("button", { name: "删除「renewlet-webdav-idle.zip」" })).toBeDisabled();
  });

  it("matches restoring state by provider and id so S3 does not inherit WebDAV loading", async () => {
    const user = userEvent.setup();
    const webdavSnapshot = snapshotFixture({
      id: "same-id",
      filename: "renewlet-webdav.zip",
      sha256: "f".repeat(64),
    });
    const s3Snapshot = snapshotFixture({
      id: "same-id",
      filename: "renewlet-s3.zip",
      provider: "s3",
      createdAt: "2026-06-09T08:10:00.000Z",
      sizeBytes: 2048,
      sha256: "0".repeat(64),
    });
    const restoreSnapshot = vi.fn(async () => undefined);
    render(<StatefulSnapshotSection
      snapshots={[webdavSnapshot, s3Snapshot]}
      restoreSnapshot={restoreSnapshot}
      deleteSnapshot={vi.fn(async () => undefined)}
      isDownloading
      restoringSnapshotKey="webdav:same-id"
    />);
    expect(screen.getByText("renewlet-webdav.zip")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在恢复「renewlet-webdav.zip」" })).toHaveAttribute("aria-busy", "true");

    await user.click(screen.getByRole("tab", { name: "S3 兼容存储" }));

    expect(screen.getByText("renewlet-s3.zip")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "正在恢复「renewlet-s3.zip」" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复「renewlet-s3.zip」" })).toBeDisabled();

    expect(restoreSnapshot).not.toHaveBeenCalled();
  });

  it("matches deleting state by provider and id so S3 does not inherit WebDAV loading", async () => {
    const user = userEvent.setup();
    const webdavSnapshot = snapshotFixture({
      id: "same-id",
      filename: "renewlet-webdav.zip",
      sha256: "f".repeat(64),
    });
    const s3Snapshot = snapshotFixture({
      id: "same-id",
      filename: "renewlet-s3.zip",
      provider: "s3",
      createdAt: "2026-06-09T08:10:00.000Z",
      sizeBytes: 2048,
      sha256: "0".repeat(64),
    });
    const deleteSnapshot = vi.fn(async () => undefined);
    render(<StatefulSnapshotSection
      snapshots={[webdavSnapshot, s3Snapshot]}
      restoreSnapshot={vi.fn(async () => undefined)}
      deleteSnapshot={deleteSnapshot}
      isDeleting
      deletingSnapshotKey="webdav:same-id"
    />);
    expect(screen.getByText("renewlet-webdav.zip")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在删除「renewlet-webdav.zip」" })).toHaveAttribute("aria-busy", "true");

    await user.click(screen.getByRole("tab", { name: "S3 兼容存储" }));

    expect(screen.getByText("renewlet-s3.zip")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "正在删除「renewlet-s3.zip」" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除「renewlet-s3.zip」" })).toBeDisabled();

    expect(deleteSnapshot).not.toHaveBeenCalled();
  });

  it("keeps delete confirmation open and busy until the delete promise settles", async () => {
    const user = userEvent.setup();
    const snapshot = snapshotFixture({
      id: "delete-pending-id",
      filename: "renewlet-delete.zip",
      sha256: "d".repeat(64),
    });
    let resolveDelete: () => void = () => undefined;
    const deleteSnapshot = vi.fn(() => new Promise<void>((resolve) => {
      resolveDelete = resolve;
    }));
    const { rerender } = render(<CloudBackupSection controller={createController({
      snapshots: readState([snapshot]),
      deleteSnapshot,
    })} />);

    await user.click(screen.getByRole("button", { name: "删除「renewlet-delete.zip」" }));
    const dialog = screen.getByRole("alertdialog", { name: "删除「renewlet-delete.zip」？" });
    await user.click(within(dialog).getByRole("button", { name: "删除" }));

    expect(deleteSnapshot).toHaveBeenCalledWith(snapshot);

    rerender(<CloudBackupSection controller={createController({
      snapshots: readState([snapshot]),
      isDeleting: true,
      deletingSnapshotKey: "webdav:delete-pending-id",
      deleteSnapshot,
    })} />);

    const pendingDialog = screen.getByRole("alertdialog", { name: "删除「renewlet-delete.zip」？" });
    expect(within(pendingDialog).getByRole("button", { name: "删除中..." })).toHaveAttribute("aria-busy", "true");
    expect(within(pendingDialog).getByRole("button", { name: "取消" })).toBeDisabled();

    resolveDelete();
  });

  it("keeps async action names stable while showing loading state", () => {
    const { rerender } = render(<CloudBackupSection controller={createController({ isSaving: true })} />);

    expect(screen.getByRole("button", { name: "保存配置" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("保存中")).toBeInTheDocument();

    rerender(<CloudBackupSection controller={createController({ isTesting: true })} />);
    expect(screen.getByRole("button", { name: "测试连接" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("测试中...")).toBeInTheDocument();

    rerender(<CloudBackupSection controller={createController({ isCreating: true })} />);
    expect(screen.getByRole("button", { name: "立即备份" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("备份中...")).toBeInTheDocument();
  });

  it("disables cloud backup inputs and remote actions when requested", () => {
    const snapshot = snapshotFixture({
      id: "disabled-snapshot-id",
      filename: "renewlet-disabled.zip",
      sha256: "a".repeat(64),
    });

    render(<CloudBackupSection
      controller={createController({
        credentialSet: true,
        canCreateSnapshot: true,
        snapshots: readState([snapshot]),
      })}
      disabled
    />);

    expect(screen.getByRole("tab", { name: "WebDAV" })).toBeDisabled();
    expect(screen.getByLabelText("WebDAV 地址")).toBeDisabled();
    expect(screen.getByLabelText("用户名")).toBeDisabled();
    expect(screen.getByLabelText("密码")).toBeDisabled();
    expect(screen.getByLabelText("定时自动备份")).toBeDisabled();
    expect(screen.getByLabelText("保留数量")).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "测试连接" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "立即备份" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "恢复「renewlet-disabled.zip」" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除「renewlet-disabled.zip」" })).toBeDisabled();
  });

  it("shows raw response details for snapshot list failures", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const openSnapshotsErrorDetails = vi.fn();
    const cloudBackupErrorDetails = {
      message: "云端快照列表加载失败",
      responseText: "<Error><Code>AccessDenied</Code></Error>",
    };
    const staleSnapshots = readState([snapshotFixture({ filename: "renewlet-cached.zip" })], { error: new Error("云端快照列表加载失败") });
    const controller = createController({
      snapshots: staleSnapshots,
      snapshotsErrorMessage: "云端快照列表加载失败",
      openSnapshotsErrorDetails,
      cloudBackupErrorDetails,
    });
    const { rerender } = render(<CloudBackupSection controller={controller} />);
    expect(screen.getByText("未更新")).toBeInTheDocument();
    expect(screen.getByText("renewlet-cached.zip")).toBeInTheDocument();
    expect(screen.queryByText("云端快照列表加载失败")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看错误详情" }));
    expect(openSnapshotsErrorDetails).toHaveBeenCalled();

    rerender(<CloudBackupSection controller={createController({
      snapshots: staleSnapshots,
      snapshotsErrorMessage: "云端快照列表加载失败",
      cloudBackupErrorDetailsOpen: true,
      cloudBackupErrorDetails,
    })} />);
    expect(screen.getByRole("dialog", { name: "云存储错误详情" })).toBeInTheDocument();
    expect(screen.queryByText(/CLOUD_BACKUP_S3_LIST_FAILED/)).not.toBeInTheDocument();
    expect(screen.queryByText(/rawResponseText/)).not.toBeInTheDocument();
    expect(screen.getByText(/AccessDenied/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "复制错误详情" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("<Error><Code>AccessDenied</Code></Error>"));
  });
});
