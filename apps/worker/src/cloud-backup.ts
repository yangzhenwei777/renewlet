import { persistedCloudBackupErrorMessage, stableCloudBackupErrorCode } from "./cloud-backup-errors";
import {
  CLOUD_BACKUP_DEFAULT_RETENTION,
  CLOUD_BACKUP_DEFAULT_SCHEDULE_TIME,
  CLOUD_BACKUP_DEFAULT_SCHEDULE_WEEKDAY,
  CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS,
  cloudBackupConfigPayloadSchema,
  cloudBackupConfigUpdateSchema,
  cloudBackupCreateSnapshotRequestSchema,
  cloudBackupCreateSnapshotPayloadSchema,
  cloudBackupPolicySchema,
  cloudBackupS3ConfigSchema,
  cloudBackupSnapshotsPayloadSchema,
  cloudBackupTestPayloadSchema,
  cloudBackupWebDavConfigSchema,
  type CloudBackupConfig,
  type CloudBackupConfigUpdate,
  type CloudBackupErrorDetails,
  type CloudBackupPolicy,
  type CloudBackupProvider,
  type CloudBackupS3Config,
  type CloudBackupSnapshot,
  type CloudBackupSnapshotManifest,
  type CloudBackupWebDavConfig,
} from "@renewlet/shared/schemas/cloud-backup";
// Cloudflare 云备份在 D1 保存策略与锁、R2 保存 ZIP，对外只暴露脱敏后的上游错误详情。
import {
  boolToInt,
  getSettings,
  nowIso,
} from "./db";
import { requireAuth } from "./auth";
import { HttpError, ok, readJson, requestLocale, successJson, type AppLocale } from "./http";
import { DEFAULT_SERVER_I18N_LOCALE, serverText } from "./server-i18n";
import {
  CloudBackupRemoteError,
  S3CloudBackupClient,
  WebDAVCloudBackupClient,
  sanitizeDownloadFilename,
  type CloudBackupRemoteClient,
  type CloudBackupPagedRemoteClient,
} from "./cloud-backup-remote";
import { cloudBackupProviderFromRequest, cloudBackupProviderParameterError } from "./cloud-backup-provider";
import { cloudBackupNextRunAt, cloudBackupTargetDue, createDefaultFallbackSettings } from "./cloud-backup-schedule";
import { deleteCloudBackupFromTargets, downloadCloudBackupFromTargets, type CloudBackupTarget } from "./cloud-backup-snapshot-resolve";
import { buildCloudBackupSnapshotPayload, verifySnapshotBytes, type CloudBackupSnapshotPayload } from "./cloud-backup-export";
import { bytesForFetchBody, parseJsonObject } from "./cloud-backup-utils";
import type { CloudBackupTargetRow, Env, UserRow } from "./types";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { CronBudgetExceeded, type CronBudget } from "./cron-budget";
import { readCloudBackupCursor, runCloudBackupStep } from "./cloud-backup-cron";
import { WebDAVOperationLimitExceeded } from "./cloud-backup-webdav";

const CLOUD_BACKUP_COLUMNS = [
  "user_id",
  "provider",
  "config_json",
  "credential_json",
  "schedule_enabled",
  "schedule_frequency",
  "schedule_time",
  "schedule_weekday",
  "retention",
  "last_backup_at",
  "last_status",
  "last_error",
  "locked_until",
  "next_run_at_utc",
  "created_at",
  "updated_at",
] as const;

const CLOUD_BACKUP_CONFIG_COLUMNS = CLOUD_BACKUP_COLUMNS.join(", ");
const CLOUD_BACKUP_LOCK_MS = 15 * 60 * 1000;

type StoredCloudBackupConfig = {
  webdav?: CloudBackupWebDavConfig;
  s3?: CloudBackupS3Config;
};

type StoredCloudBackupCredential = {
  webdavPassword?: string;
  s3SecretAccessKey?: string;
};

type CloudBackupCredentialState = {
  webdav: boolean;
  s3: boolean;
};

type ResolvedCloudBackupConfig = {
  userId: string;
  provider: CloudBackupProvider;
  targets: Partial<Record<CloudBackupProvider, ResolvedCloudBackupTarget>>;
  updatedAt: string | null;
};

type ResolvedCloudBackupTarget = {
  row: CloudBackupTargetRow | null;
  userId: string;
  provider: CloudBackupProvider;
  webdav?: CloudBackupWebDavConfig;
  s3?: CloudBackupS3Config;
  credential: StoredCloudBackupCredential;
  policy: CloudBackupPolicy;
  lastBackupAt: string | null;
  lastStatus: "idle" | "success" | "failed";
  lastError: string | null;
  lockedUntil: string | null;
  nextRunAt: string | null;
  updatedAt: string | null;
};

type ConfiguredCloudBackupTarget = CloudBackupTarget & {
  retention: number;
};

type ServerTextKey = Parameters<typeof serverText>[1];

export async function readCloudBackupConfig(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const config = await getCloudBackupConfig(env, auth.user.id);
  return successJson(cloudBackupConfigPayloadSchema.parse({ config: toConfigDTO(config) }));
}

export async function updateCloudBackupConfig(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, cloudBackupConfigUpdateSchema, locale);
  const saved = await saveCloudBackupConfig(env, auth.user.id, body);
  return successJson(cloudBackupConfigPayloadSchema.parse({ config: toConfigDTO(saved) }));
}

export async function testCloudBackupConfig(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, cloudBackupConfigUpdateSchema, locale);
  const current = await getCloudBackupTarget(env, auth.user.id, body.provider);
  const target = targetFromUpdate(auth.user.id, body, current);
  const client = remoteClientForTarget(target, locale);
  await client.test().catch((error: unknown) => {
    throw cloudBackupOperationError(locale, "cloudBackup.testFailed", error);
  });
  return successJson(cloudBackupTestPayloadSchema.parse({
    checkedAt: nowIso(),
  }));
}

export async function listCloudBackups(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const locale = requestLocale(request);
  const providerQuery = cloudBackupProviderFromRequest(request, locale);
  if (!providerQuery.hasProvider) {
    throw cloudBackupProviderParameterError(locale, "CLOUD_BACKUP_PROVIDER_REQUIRED", "Use provider=webdav or provider=s3.");
  }
  // 列表是 provider-scoped API；当前 tab 只访问当前目标，另一个目标的上游错误不能污染本响应。
  const target = await configuredCloudBackupTargetForProvider(env, auth.user.id, providerQuery.provider, locale);
  const manifests = await target.client.list().catch((error: unknown) => {
    throw cloudBackupOperationError(locale, "cloudBackup.listFailed", error);
  });
  const snapshots: CloudBackupSnapshot[] = snapshotsFromManifests(target.provider, manifests);
  snapshots.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return successJson(cloudBackupSnapshotsPayloadSchema.parse({ snapshots }));
}

export async function createCloudBackup(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readCloudBackupCreateRequest(request, locale);
  try {
    const snapshots = await createCloudBackupForUserProvider(env, auth.user, locale, body.provider);
    return successJson(cloudBackupCreateSnapshotPayloadSchema.parse({ snapshots }), { status: 201 });
  } catch (error) {
    await markCloudBackupStatus(env, auth.user.id, body.provider, "failed", persistedCloudBackupErrorMessage(error));
    throw cloudBackupOperationError(locale, "cloudBackup.createFailed", error);
  }
}

async function readCloudBackupCreateRequest(request: Request, locale: AppLocale) {
  try {
    return await readJson(request, cloudBackupCreateSnapshotRequestSchema, locale);
  } catch (error) {
    if (error instanceof HttpError && error.code === "INVALID_PAYLOAD") {
      throw cloudBackupProviderParameterError(locale, "CLOUD_BACKUP_PROVIDER_INVALID", `Use JSON body {"provider":"webdav"} or {"provider":"s3"}.`);
    }
    throw error;
  }
}

export async function downloadCloudBackup(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireAuth(request, env);
  const locale = requestLocale(request);
  const snapshotId = id.trim();
  if (!snapshotId) throw new HttpError(400, serverText(locale, "cloudBackup.snapshotInvalid"), "CLOUD_BACKUP_SNAPSHOT_INVALID");
  const providerQuery = cloudBackupProviderFromRequest(request, locale);
  let content: Uint8Array;
  let manifest: CloudBackupSnapshotManifest;
  if (providerQuery.hasProvider) {
    const client = await configuredCloudBackupClientForProvider(env, auth.user.id, providerQuery.provider, locale);
    ({ content, manifest } = await client.download(snapshotId).catch((error: unknown) => {
      throw cloudBackupOperationError(locale, "cloudBackup.downloadFailed", error);
    }));
    if (!(await verifySnapshotBytes(content, manifest))) {
      throw new HttpError(400, serverText(locale, "cloudBackup.checksumFailed"), "CLOUD_BACKUP_CHECKSUM_FAILED");
    }
  } else {
    ({ content, manifest } = await downloadCloudBackupWithoutProvider(env, auth.user.id, locale, snapshotId).catch((error: unknown) => {
      throw cloudBackupOperationError(locale, "cloudBackup.downloadFailed", error);
    }));
  }

  // 恢复下载只返回经过 sidecar manifest 校验的 ZIP；前端仍必须交给导入预览，不能直接覆盖 D1。
  const headers = new Headers();
  headers.set("content-type", "application/zip");
  headers.set("content-disposition", `attachment; filename="${sanitizeDownloadFilename(manifest.filename)}"`);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(bytesForFetchBody(content), { headers });
}

export async function deleteCloudBackup(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireAuth(request, env);
  const locale = requestLocale(request);
  const snapshotId = id.trim();
  if (!snapshotId) throw new HttpError(400, serverText(locale, "cloudBackup.snapshotInvalid"), "CLOUD_BACKUP_SNAPSHOT_INVALID");
  const providerQuery = cloudBackupProviderFromRequest(request, locale);
  if (providerQuery.hasProvider) {
    const client = await configuredCloudBackupClientForProvider(env, auth.user.id, providerQuery.provider, locale);
    await client.delete(snapshotId).catch((error: unknown) => {
      throw cloudBackupOperationError(locale, "cloudBackup.deleteFailed", error);
    });
  } else {
    await deleteCloudBackupWithoutProvider(env, auth.user.id, locale, snapshotId).catch((error: unknown) => {
      const messageKey = error instanceof CloudBackupRemoteError && error.code === "CLOUD_BACKUP_PROVIDER_REQUIRED"
        ? "cloudBackup.providerRequired"
        : "cloudBackup.deleteFailed";
      throw cloudBackupOperationError(locale, messageKey, error);
    });
  }
  return ok();
}

export async function runScheduledCloudBackupForUser(
  env: Env,
  userId: string,
  provider: CloudBackupProvider,
  scheduledAt: Date,
  now: Date,
  settings: ApiAppSettings,
  budget: CronBudget,
  checkpointDB: D1Database,
): Promise<boolean> {
  const target = await getCloudBackupTarget(env, userId, provider);
  if (!target.policy.scheduleEnabled) return true;
  const stored = await env.DB.prepare("SELECT cron_cursor_json FROM cloud_backup_targets WHERE user_id = ? AND provider = ?")
    .bind(userId, provider).first<{ cron_cursor_json: string }>();
  if (!stored) return true;
  if (stored.cron_cursor_json === "{}" && !cloudBackupTargetDue(target, settings.timezone, scheduledAt)) {
    await env.DB.prepare("UPDATE cloud_backup_targets SET next_run_at_utc = ? WHERE user_id = ? AND provider = ? AND updated_at = ?")
      .bind(cloudBackupNextRunAt(target, settings.timezone, scheduledAt), userId, provider, target.updatedAt).run();
    return true;
  }
  // provider锁只覆盖当前工作片；其它provider和下一天的通知不等待完整远端保留策略结束。
  const claimToken = await acquireCloudBackupLock(env, userId, provider, now, target.updatedAt, stored.cron_cursor_json);
  if (!claimToken) return true;
  const lockedUntil = new Date(now.getTime() + CLOUD_BACKUP_LOCK_MS).toISOString();
  try {
    const outcome = await runCloudBackupStep({
      env, userId, provider, client: remoteClientForTarget(target, DEFAULT_SERVER_I18N_LOCALE, budget),
      cursor: readCloudBackupCursor(stored.cron_cursor_json), retention: target.policy.retention, now, budget,
    });
    const complete = outcome.kind === "complete";
    const backupAt = complete ? outcome.createdAt : target.lastBackupAt;
    const nextRun = complete
      ? cloudBackupNextRunAt({ ...target, lastBackupAt: backupAt }, settings.timezone, now)
      : target.nextRunAt;
    const result = await checkpointDB.prepare(`UPDATE cloud_backup_targets
      SET cron_cursor_json = ?, locked_until = NULL, cron_claim_token = NULL, last_backup_at = ?, next_run_at_utc = ?,
          last_status = ?, last_error = ?, updated_at = ?
      WHERE user_id = ? AND provider = ? AND locked_until = ? AND cron_cursor_json = ? AND cron_claim_token = ?`)
      .bind(complete ? "{}" : JSON.stringify(outcome.cursor), backupAt, nextRun,
        complete ? "success" : outcome.failure ? "failed" : target.lastStatus, complete ? null : outcome.failure ?? target.lastError, nowIso(),
        userId, provider, lockedUntil, stored.cron_cursor_json, claimToken).run();
    return result.meta.changes === 1;
  } catch (error) {
    // 游标保留在失败之前的阶段；已上传的固定ID不会因为保留策略失败而重新生成另一份快照。
    const message = error instanceof CronBudgetExceeded ? error.message : persistedCloudBackupErrorMessage(error);
    // 单操作已用满完整外发额度时关闭当前目标的定时开关；保留断点，修正配置后由用户重新开启。
    const pause = error instanceof WebDAVOperationLimitExceeded;
    const result = await checkpointDB.prepare(`UPDATE cloud_backup_targets
      SET locked_until = NULL, cron_claim_token = NULL, last_status = 'failed', last_error = ?, updated_at = ?,
          schedule_enabled = CASE WHEN ? THEN 0 ELSE schedule_enabled END,
          next_run_at_utc = CASE WHEN ? THEN NULL ELSE next_run_at_utc END
      WHERE user_id = ? AND provider = ? AND locked_until = ? AND cron_cursor_json = ? AND cron_claim_token = ?`)
      .bind(message, nowIso(), boolToInt(pause), boolToInt(pause), userId, provider, lockedUntil, stored.cron_cursor_json, claimToken).run();
    return result.meta.changes === 1;
  }
}

async function configuredCloudBackupTargets(env: Env, userId: string, locale: AppLocale): Promise<{
  config: ResolvedCloudBackupConfig;
  targets: CloudBackupTarget[];
}> {
  const config = await getCloudBackupConfig(env, userId);
  const targets = cloudBackupTargetsForConfig(config);
  if (targets.length === 0) throw new HttpError(400, serverText(locale, "cloudBackup.configIncomplete"), "CLOUD_BACKUP_TARGET_REQUIRED");
  return { config, targets };
}

async function configuredCloudBackupClientForProvider(env: Env, userId: string, provider: CloudBackupProvider, locale: AppLocale): Promise<CloudBackupRemoteClient> {
  return (await configuredCloudBackupTargetForProvider(env, userId, provider, locale)).client;
}

async function configuredCloudBackupTargetForProvider(env: Env, userId: string, provider: CloudBackupProvider, locale: AppLocale): Promise<ConfiguredCloudBackupTarget> {
  const config = await getCloudBackupConfig(env, userId);
  const target = cloudBackupTargetForProvider(config, provider)[0];
  if (!target) throw new HttpError(400, serverText(locale, "cloudBackup.configIncomplete"), "CLOUD_BACKUP_TARGET_REQUIRED");
  return target;
}

function remoteClientForProvider(config: ResolvedCloudBackupConfig, provider: CloudBackupProvider, locale: AppLocale): CloudBackupRemoteClient {
  const target = config.targets[provider];
  if (!target) throw new HttpError(400, serverText(locale, "cloudBackup.configIncomplete"), "CLOUD_BACKUP_TARGET_REQUIRED");
  return remoteClientForTarget(target, locale);
}

function remoteClientForTarget(target: ResolvedCloudBackupTarget, locale: AppLocale, budget?: CronBudget): CloudBackupPagedRemoteClient {
  if (target.provider === "webdav") {
    if (!target.webdav) throw new HttpError(400, serverText(locale, "cloudBackup.configIncomplete"), "CLOUD_BACKUP_WEBDAV_REQUIRED");
    if (!target.credential.webdavPassword?.trim()) throw new HttpError(400, serverText(locale, "cloudBackup.configIncomplete"), "CLOUD_BACKUP_WEBDAV_CREDENTIAL_REQUIRED");
    return new WebDAVCloudBackupClient(target.webdav, target.credential.webdavPassword, budget);
  }
  if (!target.s3) throw new HttpError(400, serverText(locale, "cloudBackup.configIncomplete"), "CLOUD_BACKUP_S3_REQUIRED");
  if (!target.s3.accessKeyId?.trim() || !target.credential.s3SecretAccessKey?.trim()) {
    throw new HttpError(400, serverText(locale, "cloudBackup.configIncomplete"), "CLOUD_BACKUP_S3_CREDENTIAL_REQUIRED");
  }
  return new S3CloudBackupClient(target.s3, target.credential.s3SecretAccessKey, budget);
}

function cloudBackupTargetsForConfig(config: ResolvedCloudBackupConfig): CloudBackupTarget[] {
  // 只有配置完整且密钥已保存的 provider 才参与多目标备份；未配置目标不能阻断另一目标。
  return cloudBackupTargetProvidersForConfig(config).flatMap((provider) => cloudBackupTargetForProvider(config, provider));
}

function cloudBackupTargetProvidersForConfig(config: ResolvedCloudBackupConfig): CloudBackupProvider[] {
  const providers: CloudBackupProvider[] = [];
  if (config.provider === "webdav" || config.provider === "s3") providers.push(config.provider);
  for (const provider of ["webdav", "s3"] as const) {
    if (provider !== config.provider) providers.push(provider);
  }
  return providers;
}

function cloudBackupTargetForProvider(config: ResolvedCloudBackupConfig, provider: CloudBackupProvider): ConfiguredCloudBackupTarget[] {
  try {
    const target = config.targets[provider];
    if (!target) return [];
    return [configuredTargetFromResolvedTarget(target, DEFAULT_SERVER_I18N_LOCALE)];
  } catch {
    return [];
  }
}

function configuredTargetFromResolvedTarget(target: ResolvedCloudBackupTarget, locale: AppLocale): ConfiguredCloudBackupTarget {
  return { provider: target.provider, client: remoteClientForTarget(target, locale), retention: target.policy.retention };
}

async function getCloudBackupConfig(env: Env, userId: string): Promise<ResolvedCloudBackupConfig> {
  const rows = await env.DB.prepare(`SELECT ${CLOUD_BACKUP_CONFIG_COLUMNS} FROM cloud_backup_targets WHERE user_id = ? ORDER BY updated_at DESC`).bind(userId).all<CloudBackupTargetRow>();
  const config = defaultConfig(userId);
  for (const row of rows.results) {
    const target = rowToTarget(row);
    config.targets[target.provider] = target;
    if (!config.updatedAt || (target.updatedAt && target.updatedAt > config.updatedAt)) {
      config.updatedAt = target.updatedAt;
      config.provider = target.provider;
    }
  }
  return config;
}

async function getCloudBackupTarget(env: Env, userId: string, provider: CloudBackupProvider): Promise<ResolvedCloudBackupTarget> {
  const row = await env.DB.prepare(`SELECT ${CLOUD_BACKUP_CONFIG_COLUMNS} FROM cloud_backup_targets WHERE user_id = ? AND provider = ? LIMIT 1`).bind(userId, provider).first<CloudBackupTargetRow>();
  return row ? rowToTarget(row) : defaultTarget(userId, provider);
}

async function saveCloudBackupConfig(env: Env, userId: string, body: CloudBackupConfigUpdate): Promise<ResolvedCloudBackupConfig> {
  const current = await getCloudBackupTarget(env, userId, body.provider);
  const next = targetFromUpdate(userId, body, current);
  const timestamp = nowIso();
  const settings = await getSettings(env, userId).catch(() => createDefaultFallbackSettings());
  const nextRunAt = cloudBackupNextRunAt(next, settings.timezone, new Date());
  // user+provider 是唯一写入边界；配置更新使旧游标/锁失效，旧执行者不能覆盖新目标。
  await env.DB.prepare(`
    INSERT INTO cloud_backup_targets (
      user_id, provider, config_json, credential_json, schedule_enabled, schedule_frequency, schedule_time,
      schedule_weekday, retention, last_status, last_error, next_run_at_utc, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      config_json = excluded.config_json,
      credential_json = excluded.credential_json,
      schedule_enabled = excluded.schedule_enabled,
      schedule_frequency = excluded.schedule_frequency,
      schedule_time = excluded.schedule_time,
      schedule_weekday = excluded.schedule_weekday,
      retention = excluded.retention,
      next_run_at_utc = excluded.next_run_at_utc,
      cron_cursor_json = '{}',
      locked_until = NULL, cron_claim_token = NULL,
      updated_at = excluded.updated_at
  `).bind(
    userId,
    next.provider,
    JSON.stringify(storedConfigFromTarget(next)),
    JSON.stringify(next.credential),
    boolToInt(next.policy.scheduleEnabled),
    next.policy.scheduleFrequency,
    next.policy.scheduleTime,
    next.policy.scheduleWeekday,
    next.policy.retention,
    nextRunAt,
    timestamp,
    timestamp,
  ).run();
  return await getCloudBackupConfig(env, userId);
}

function rowToTarget(row: CloudBackupTargetRow): ResolvedCloudBackupTarget {
  const stored = parseJsonObject<StoredCloudBackupConfig>(row.config_json);
  const webdavResult = stored.webdav ? cloudBackupWebDavConfigSchema.safeParse(stored.webdav) : null;
  const s3Result = stored.s3 ? cloudBackupS3ConfigSchema.safeParse(stored.s3) : null;
  const webdav = webdavResult?.success ? webdavResult.data : undefined;
  const s3 = s3Result?.success ? s3Result.data : undefined;
  return {
    row,
    userId: row.user_id,
    provider: row.provider,
    credential: parseJsonObject<StoredCloudBackupCredential>(row.credential_json),
    policy: cloudBackupPolicySchema.parse({
      scheduleEnabled: row.schedule_enabled === 1,
      scheduleFrequency: row.schedule_frequency || "daily",
      scheduleTime: row.schedule_time || CLOUD_BACKUP_DEFAULT_SCHEDULE_TIME,
      scheduleWeekday: row.schedule_weekday || CLOUD_BACKUP_DEFAULT_SCHEDULE_WEEKDAY,
      retention: row.retention > 0 ? row.retention : CLOUD_BACKUP_DEFAULT_RETENTION,
    }),
    lastBackupAt: row.last_backup_at,
    lastStatus: row.last_status || "idle",
    lastError: row.last_error,
    lockedUntil: row.locked_until,
    nextRunAt: row.next_run_at_utc ?? null,
    updatedAt: row.updated_at,
    ...(webdav ? { webdav } : {}),
    ...(s3 ? { s3 } : {}),
  };
}

function defaultConfig(userId: string): ResolvedCloudBackupConfig {
  return {
    userId,
    provider: "webdav",
    targets: {},
    updatedAt: null,
  };
}

function defaultTarget(userId: string, provider: CloudBackupProvider): ResolvedCloudBackupTarget {
  return {
    row: null,
    userId,
    provider,
    credential: {},
    policy: cloudBackupPolicySchema.parse({}),
    lastBackupAt: null,
    lastStatus: "idle",
    lastError: null,
    lockedUntil: null,
    nextRunAt: null,
    updatedAt: null,
  };
}

function targetFromUpdate(userId: string, body: CloudBackupConfigUpdate, current: ResolvedCloudBackupTarget): ResolvedCloudBackupTarget {
  const credential = { ...current.credential };
  // provider 行是本次保存的写入边界；另一个目标有独立 D1 行，避免策略、状态或 secret 串目标。
  if (body.provider === "webdav" && body.credentials?.webdavPassword?.trim()) credential.webdavPassword = body.credentials.webdavPassword;
  if (body.provider === "s3" && body.credentials?.s3SecretAccessKey?.trim()) credential.s3SecretAccessKey = body.credentials.s3SecretAccessKey;
  const next: ResolvedCloudBackupTarget = {
    ...current,
    userId,
    provider: body.provider,
    credential,
    policy: body.policy,
  };
  if (body.provider === "webdav" && body.webdav) {
    const { s3: _s3, ...withoutS3 } = next;
    return { ...withoutS3, webdav: body.webdav };
  }
  if (body.provider === "s3" && body.s3) {
    const { webdav: _webdav, ...withoutWebDAV } = next;
    return { ...withoutWebDAV, s3: body.s3 };
  }
  return next;
}

function toConfigDTO(config: ResolvedCloudBackupConfig): CloudBackupConfig {
  return cloudBackupConfigPayloadSchema.parse({
    config: {
      provider: config.provider,
      ...(config.targets.webdav?.webdav ? { webdav: config.targets.webdav.webdav } : {}),
      ...(config.targets.s3?.s3 ? { s3: config.targets.s3.s3 } : {}),
      credentialSet: credentialSet(config),
      credentialSetByProvider: credentialSetByProvider(config),
      policyByProvider: {
        webdav: config.targets.webdav?.policy ?? cloudBackupPolicySchema.parse({}),
        s3: config.targets.s3?.policy ?? cloudBackupPolicySchema.parse({}),
      },
      statusByProvider: {
        webdav: statusForTarget(config.targets.webdav),
        s3: statusForTarget(config.targets.s3),
      },
      updatedAt: config.updatedAt,
    },
  }).config;
}

function credentialSet(config: ResolvedCloudBackupConfig): boolean {
  return credentialSetForTarget(config.targets[config.provider]);
}

function credentialSetByProvider(config: ResolvedCloudBackupConfig): CloudBackupCredentialState {
  return {
    webdav: credentialSetForTarget(config.targets.webdav),
    s3: credentialSetForTarget(config.targets.s3),
  };
}

async function createCloudBackupForUserProvider(env: Env, user: UserRow, locale: AppLocale, provider: CloudBackupProvider): Promise<CloudBackupSnapshot[]> {
  const config = await getCloudBackupConfig(env, user.id);
  const target = cloudBackupTargetForProvider(config, provider)[0];
  if (!target) throw new HttpError(400, serverText(locale, "cloudBackup.configIncomplete"), "CLOUD_BACKUP_TARGET_REQUIRED");
  const payload = await buildCloudBackupSnapshotPayload(env, user.id);
  return [await uploadCloudBackupSnapshotToTarget(env, user.id, payload, target)];
}

async function uploadCloudBackupSnapshotToTarget(env: Env, userId: string, payload: CloudBackupSnapshotPayload, target: ConfiguredCloudBackupTarget): Promise<CloudBackupSnapshot> {
  // 远端快照只以 sidecar manifest 为可信索引；下载时仍会重算 sha256，坏包不能进入导入预览。
  await target.client.upload(payload.filename, payload.content, payload.manifest);
  await enforceRetention(target.client, target.retention, payload.id);
  await markCloudBackupSuccess(env, userId, target.provider, payload.manifest.createdAt);
  return snapshotFromManifest(target.provider, payload.manifest);
}

async function downloadCloudBackupWithoutProvider(env: Env, userId: string, locale: AppLocale, id: string): Promise<{ content: Uint8Array; manifest: CloudBackupSnapshotManifest }> {
  const { targets } = await configuredCloudBackupTargets(env, userId, locale);
  return await downloadCloudBackupFromTargets(targets, id);
}

async function deleteCloudBackupWithoutProvider(env: Env, userId: string, locale: AppLocale, id: string): Promise<void> {
  const { targets } = await configuredCloudBackupTargets(env, userId, locale);
  await deleteCloudBackupFromTargets(targets, id);
}

async function enforceRetention(client: CloudBackupRemoteClient, retention: number, keepId: string): Promise<void> {
  // retention 使用与设置页相同的严格列表语义；列表或 manifest 损坏时必须保留阶段错误，不能把成功上传伪装成完整成功。
  const manifests = await client.list();
  manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const [index, manifest] of manifests.entries()) {
    if (index < retention || manifest.id === keepId) continue;
    await client.delete(manifest.id);
  }
}

async function markCloudBackupSuccess(env: Env, userId: string, provider: CloudBackupProvider, backupAt: string): Promise<void> {
  const target = await getCloudBackupTarget(env, userId, provider);
  const settings = await getSettings(env, userId).catch(() => createDefaultFallbackSettings());
  const nextRunAt = cloudBackupNextRunAt({ ...target, lastBackupAt: backupAt }, settings.timezone, new Date(backupAt));
  await env.DB.prepare(`
    UPDATE cloud_backup_targets
    SET last_backup_at = ?, last_status = 'success', last_error = NULL, locked_until = NULL, cron_claim_token = NULL, next_run_at_utc = ?, updated_at = ?
    WHERE user_id = ? AND provider = ?
  `).bind(backupAt, nextRunAt, nowIso(), userId, provider).run();
}

async function markCloudBackupStatus(env: Env, userId: string, provider: CloudBackupProvider, status: "idle" | "success" | "failed", message: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE cloud_backup_targets
    SET last_status = ?, last_error = ?, locked_until = NULL, cron_claim_token = NULL, updated_at = ?
    WHERE user_id = ? AND provider = ?
  `).bind(status, message.slice(0, 2000), nowIso(), userId, provider).run();
}

async function acquireCloudBackupLock(env: Env, userId: string, provider: CloudBackupProvider, now: Date, version: string | null, cursor: string): Promise<string | null> {
  const lockedUntil = new Date(now.getTime() + CLOUD_BACKUP_LOCK_MS).toISOString();
  const token = crypto.randomUUID();
  // 配置版本与进度一起抢占；读取后被用户改过的旧目标不能发送或覆盖新配置。
  const result = await env.DB.prepare(`
    UPDATE cloud_backup_targets SET locked_until = ?, cron_claim_token = ?, updated_at = ?
    WHERE user_id = ? AND provider = ? AND updated_at = ? AND cron_cursor_json = ?
      AND (locked_until IS NULL OR locked_until = '' OR locked_until <= ?)
  `).bind(lockedUntil, token, nowIso(), userId, provider, version, cursor, now.toISOString()).run();
  return result.meta.changes === 1 ? token : null;
}

function snapshotsFromManifests(provider: CloudBackupProvider, manifests: CloudBackupSnapshotManifest[]): CloudBackupSnapshot[] {
  return manifests
    .map((manifest) => snapshotFromManifest(provider, manifest))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function snapshotFromManifest(provider: CloudBackupProvider, manifest: CloudBackupSnapshotManifest): CloudBackupSnapshot {
  return {
    id: manifest.id,
    filename: manifest.filename,
    provider,
    createdAt: manifest.createdAt,
    sizeBytes: manifest.sizeBytes,
    sha256: manifest.sha256,
  };
}

function cloudBackupOperationError(locale: AppLocale, messageKey: ServerTextKey, error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof CloudBackupRemoteError) {
    // 远端阶段码直接穿过 API 边界；只有展示文案本地化，避免把真实失败阶段改写成动作错误。
    return new HttpError(400, serverText(locale, messageKey), error.code, error.details);
  }
  const code = stableCloudBackupErrorCode(errorMessage(error)) ?? "CLOUD_BACKUP_LOCAL_OPERATION_FAILED";
  return new HttpError(400, serverText(locale, messageKey), code, cloudBackupLocalErrorDetails(error));
}

function cloudBackupLocalErrorDetails(error: unknown): CloudBackupErrorDetails {
  return {
    operation: "local",
    target: "cloud backup",
    clientMessage: errorMessage(error).slice(0, CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function credentialSetForTarget(target: ResolvedCloudBackupTarget | undefined): boolean {
  if (!target) return false;
  if (target.provider === "webdav") return Boolean(target.credential.webdavPassword?.trim());
  return Boolean(target.credential.s3SecretAccessKey?.trim());
}

function statusForTarget(target: ResolvedCloudBackupTarget | undefined) {
  return {
    lastBackupAt: target?.lastBackupAt ?? null,
    lastStatus: target?.lastStatus ?? "idle",
    lastError: target?.lastError ?? null,
    updatedAt: target?.updatedAt ?? null,
  };
}

function storedConfigFromTarget(target: ResolvedCloudBackupTarget): StoredCloudBackupConfig {
  return {
    ...(target.webdav ? { webdav: target.webdav } : {}),
    ...(target.s3 ? { s3: target.s3 } : {}),
  };
}
