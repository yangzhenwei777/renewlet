import { z } from "zod";
import type { CloudBackupProvider } from "@renewlet/shared/schemas/cloud-backup";
import { CRON_CLAIM_DURATION_MS, type CronBudget } from "./cron-budget";
import type { Env } from "./types";

const STAGING_PREFIX = "system/cloud-backup-staging/";
export const cloudBackupStagingKeySchema = z.string().regex(/^system\/cloud-backup-staging\/[0-9a-f-]{36}$/);
// Cron最多存活15分钟；双倍宽限覆盖登记后崩溃、租约接管和迟到写入，不依赖冻结的调度时间。
export const CLOUD_BACKUP_STAGING_GRACE_MS = 2 * CRON_CLAIM_DURATION_MS;
const STAGING_CLEANUP_PAGE_SIZE = 4;

export interface CloudBackupStagingOwner {
  userId: string;
  provider: CloudBackupProvider;
  id: string;
}

export async function saveCloudBackupStaging(
  env: Env, owner: CloudBackupStagingOwner, content: Uint8Array<ArrayBuffer>, kind: "assets" | "zip",
): Promise<string> {
  const key = `${STAGING_PREFIX}${crypto.randomUUID()}`;
  // 先登记再put：put成功但D1游标提交失败时仍可回收。每片使用新key，失去claim的旧执行者无法覆盖新内容。
  await env.DB.prepare("INSERT INTO cloud_backup_staging (r2_key, created_at) VALUES (?, ?)").bind(key, new Date().toISOString()).run();
  await env.ASSETS_BUCKET.put(key, content, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { userId: owner.userId, provider: owner.provider, snapshotId: owner.id, kind },
  });
  return key;
}

export async function readCloudBackupStaging(env: Env, owner: CloudBackupStagingOwner, key: string, kind: "assets" | "zip", maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const object = await env.ASSETS_BUCKET.get(cloudBackupStagingKeySchema.parse(key));
  if (!object) throw new Error("CLOUD_BACKUP_STAGING_MISSING");
  const metadata = object.customMetadata;
  // 临时key不进入assets表或公开下载；即使内部游标损坏，也不能读取其它账号/provider的快照。
  if (metadata?.["userId"] !== owner.userId || metadata["provider"] !== owner.provider || metadata["snapshotId"] !== owner.id || metadata["kind"] !== kind || object.size > maxBytes) {
    await object.body.cancel();
    throw new Error("CLOUD_BACKUP_STAGING_INVALID");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== object.size) throw new Error("CLOUD_BACKUP_STAGING_INVALID");
  return bytes;
}

export async function collectCloudBackupStaging(env: Env, budget: CronBudget, now: Date): Promise<void> {
  const before = new Date(now.getTime() - CLOUD_BACKUP_STAGING_GRACE_MS).toISOString();
  const rows = await env.DB.prepare(`SELECT r2_key FROM cloud_backup_staging
    WHERE created_at <= ? AND NOT EXISTS (
      SELECT 1 FROM cloud_backup_targets WHERE CAST(json_extract(cron_cursor_json, '$.stagingKey') AS TEXT) = r2_key
    ) ORDER BY created_at, r2_key LIMIT ?`).bind(before, STAGING_CLEANUP_PAGE_SIZE).all<{ r2_key: string }>();
  if (rows.results.length === 0) return;
  const keys = rows.results.map((row) => cloudBackupStagingKeySchema.parse(row.r2_key));
  budget.consumeStorage(keys.length);
  budget.requireSql(1);
  // 无外键级联：账号删除/配置重置只移除引用，登记必须保留到R2删除成功。失败重跑仍删除同一组不可变key。
  await env.ASSETS_BUCKET.delete(keys);
  await env.DB.prepare("DELETE FROM cloud_backup_staging WHERE r2_key IN (SELECT value FROM json_each(?))").bind(JSON.stringify(keys)).run();
}
