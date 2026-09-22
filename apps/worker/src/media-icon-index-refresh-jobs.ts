import { type BuiltInIconProvider } from "@renewlet/shared/built-in-icons";
import {
  builtInIconRefreshJobSchema,
  type BuiltInIconRefreshJob,
} from "@renewlet/shared/schemas/media";
import { nowIso } from "./db";
import type { Env, MediaIconIndexRefreshJobRow } from "./types";

export type ProviderRefreshJobs = Partial<Record<BuiltInIconProvider, BuiltInIconRefreshJob>>;

const REFRESH_JOB_STALE_MS = 10 * 60 * 1000;
const REFRESH_JOB_STALE_ERROR = "Built-in icon refresh job exceeded the safety timeout. Start a new refresh.";

export class MediaIconIndexRefreshJobSchemaError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : "media icon refresh job schema is unavailable");
    this.name = "MediaIconIndexRefreshJobSchemaError";
  }
}

export async function readActiveRefreshJob(env: Env, provider: BuiltInIconProvider): Promise<MediaIconIndexRefreshJobRow | null> {
  try {
    await expireStaleRefreshJobs(env, provider);
    return await env.DB.prepare(`
      SELECT * FROM media_icon_index_refresh_jobs
      WHERE provider = ? AND status IN ('queued', 'running')
      ORDER BY queued_at DESC, rowid DESC
      LIMIT 1
    `).bind(provider).first<MediaIconIndexRefreshJobRow>();
  } catch (error) {
    throw schemaErrorOrOriginal(error);
  }
}

async function readRefreshJobById(env: Env, jobId: string): Promise<MediaIconIndexRefreshJobRow | null> {
  try {
    return await env.DB.prepare("SELECT * FROM media_icon_index_refresh_jobs WHERE id = ? LIMIT 1")
      .bind(jobId)
      .first<MediaIconIndexRefreshJobRow>();
  } catch (error) {
    throw schemaErrorOrOriginal(error);
  }
}

async function readNewerRefreshJob(env: Env, provider: BuiltInIconProvider, queuedAt: string, jobId: string): Promise<MediaIconIndexRefreshJobRow | null> {
  try {
    return await env.DB.prepare(`
      SELECT * FROM media_icon_index_refresh_jobs
      WHERE provider = ? AND id != ? AND queued_at >= ?
      ORDER BY queued_at DESC, rowid DESC
      LIMIT 1
    `).bind(provider, jobId, queuedAt).first<MediaIconIndexRefreshJobRow>();
  } catch (error) {
    throw schemaErrorOrOriginal(error);
  }
}

export async function readLatestRefreshJobs(env: Env, providers: readonly BuiltInIconProvider[]): Promise<ProviderRefreshJobs> {
  try {
    await expireStaleRefreshJobs(env);
    const entries = await Promise.all(providers.map(async (provider) => {
      const row = await env.DB.prepare(`
        SELECT * FROM media_icon_index_refresh_jobs
        WHERE provider = ?
        ORDER BY queued_at DESC, rowid DESC
        LIMIT 1
      `).bind(provider).first<MediaIconIndexRefreshJobRow>();
      return row ? [provider, refreshJobFromRow(row)] as const : null;
    }));
    return Object.fromEntries(entries.filter((entry): entry is [BuiltInIconProvider, BuiltInIconRefreshJob] => Boolean(entry)));
  } catch (error) {
    // 老本地库或未跑迁移的远端不能拖垮 status；刷新入口会单独暴露 schema unavailable。
    if (isMediaIconIndexRefreshJobSchemaError(error) || isRefreshJobSchemaUnavailable(error)) return {};
    throw error;
  }
}

export async function createRefreshJob(env: Env, provider: BuiltInIconProvider): Promise<{ job: BuiltInIconRefreshJob; created: boolean }> {
  const timestamp = nowIso();
  const id = crypto.randomUUID();
  try {
    await expireStaleRefreshJobs(env, provider);
    await env.DB.prepare(`
      INSERT INTO media_icon_index_refresh_jobs (
        id, provider, status, attempts, error, index_hash, queued_at, started_at, finished_at, created_at, updated_at
      )
      VALUES (?, ?, 'queued', 0, NULL, NULL, ?, NULL, NULL, ?, ?)
    `).bind(id, provider, timestamp, timestamp, timestamp).run();
  } catch (error) {
    if (isRefreshJobSchemaUnavailable(error)) throw new MediaIconIndexRefreshJobSchemaError(error);
    // Cloudflare refresh 是异步 enqueue；并发点击同一 provider 时返回现有 active job，前端继续轮询同一任务。
    const existing = await readActiveRefreshJob(env, provider);
    if (existing) return { job: refreshJobFromRow(existing), created: false };
    throw error;
  }
  return { job: builtInIconRefreshJobSchema.parse({
    id,
    provider,
    status: "queued",
    queuedAt: timestamp,
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    error: null,
    indexHash: null,
  }), created: true };
}

export async function markRefreshJobRunning(env: Env, jobId: string, provider: BuiltInIconProvider): Promise<MediaIconIndexRefreshJobRow | null> {
  const row = await readRefreshJobById(env, jobId);
  if (!row || row.provider !== provider || row.status === "succeeded") return null;
  // retry 可能在用户重新点击后才送达；旧 failed job 不能重新变 running 覆盖更新的 queued job。
  if (row.status === "failed" && await readNewerRefreshJob(env, provider, row.queued_at, row.id)) {
    return null;
  }
  const timestamp = nowIso();
  await env.DB.prepare(`
    UPDATE media_icon_index_refresh_jobs
    SET status = 'running',
        attempts = attempts + 1,
        error = NULL,
        started_at = COALESCE(started_at, ?),
        finished_at = NULL,
        updated_at = ?
    WHERE id = ?
  `).bind(timestamp, timestamp, jobId).run();
  return await readRefreshJobById(env, jobId);
}

export async function markRefreshJobFailed(
  env: Env,
  jobId: string,
  provider: BuiltInIconProvider,
  message: string,
  indexHash: string | null,
): Promise<void> {
  const timestamp = nowIso();
  await env.DB.prepare(`
    UPDATE media_icon_index_refresh_jobs
    SET status = 'failed', error = ?, index_hash = ?, finished_at = ?, updated_at = ?
    WHERE id = ? AND provider = ?
  `).bind(message, indexHash, timestamp, timestamp, jobId, provider).run();
}

export function refreshJobFromRow(row: MediaIconIndexRefreshJobRow): BuiltInIconRefreshJob {
  // 早期未发布的本地 0028 写过 artifact_hash；正式 0029 迁移前后都要让 status/check 保持可读。
  const indexHash = row.index_hash ?? row.artifact_hash ?? null;
  return builtInIconRefreshJobSchema.parse({
    id: row.id,
    provider: row.provider,
    status: row.status,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    attempts: row.attempts,
    error: nonEmpty(row.error),
    indexHash,
  });
}

export function hasRefreshingJob(jobs: ProviderRefreshJobs): boolean {
  return Object.values(jobs).some((job) => job?.status === "queued" || job?.status === "running");
}

async function expireStaleRefreshJobs(env: Env, provider?: BuiltInIconProvider): Promise<void> {
  const timestamp = nowIso();
  const cutoff = new Date(Date.now() - REFRESH_JOB_STALE_MS).toISOString();
  // Queue consumer 被本地热重载或部署中断打断时，D1 可能只留下 running job；读状态和新建 job 前统一收敛，避免设置页永久“更新中”。
  const sql = provider
    ? `
      UPDATE media_icon_index_refresh_jobs
      SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
      WHERE provider = ? AND status IN ('queued', 'running') AND updated_at < ?
    `
    : `
      UPDATE media_icon_index_refresh_jobs
      SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
      WHERE status IN ('queued', 'running') AND updated_at < ?
    `;
  const statement = env.DB.prepare(sql);
  if (provider) {
    await statement.bind(REFRESH_JOB_STALE_ERROR, timestamp, timestamp, provider, cutoff).run();
  } else {
    await statement.bind(REFRESH_JOB_STALE_ERROR, timestamp, timestamp, cutoff).run();
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export function isMediaIconIndexRefreshJobSchemaError(error: unknown): boolean {
  return error instanceof MediaIconIndexRefreshJobSchemaError;
}

function schemaErrorOrOriginal(error: unknown): unknown {
  return isRefreshJobSchemaUnavailable(error) ? new MediaIconIndexRefreshJobSchemaError(error) : error;
}

function isRefreshJobSchemaUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /no such table:\s*media_icon_index_refresh_jobs/i.test(error.message)
    || /no such column:\s*index_hash/i.test(error.message)
    || /has no column named\s+index_hash/i.test(error.message);
}
