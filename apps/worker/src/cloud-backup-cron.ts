import { z } from "zod";
import { CLOUD_BACKUP_MAX_RETENTION, CLOUD_BACKUP_MAX_SNAPSHOT_BYTES, cloudBackupSnapshotManifestSchema, type CloudBackupProvider } from "@renewlet/shared/schemas/cloud-backup";
import { cloudBackupPayloadFromZip } from "./cloud-backup-export";
import { prepareCloudBackupAssets } from "./cloud-backup-assets";
import { cloudBackupStagingKeySchema, readCloudBackupStaging } from "./cloud-backup-staging";
import { snapshotId, type CloudBackupPagedRemoteClient } from "./cloud-backup-remote";
import { persistedCloudBackupErrorMessage } from "./cloud-backup-errors";
import { CronBudgetExceeded, type CronBudget } from "./cron-budget";
import type { Env } from "./types";

const BACKUP_PAGE_SIZE = 4;
const snapshotKey = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]+$/), createdAt: z.iso.datetime() }).strict();
const common = { id: snapshotKey.shape.id, createdAt: snapshotKey.shape.createdAt };
const retained = z.array(snapshotKey).max(CLOUD_BACKUP_MAX_RETENTION);
type RetainedSnapshots = z.infer<typeof retained>;
const page = { after: z.string().nullable(), retained, pending: z.array(z.string()).max(BACKUP_PAGE_SIZE) };
const upload = { ...common, stagingKey: cloudBackupStagingKeySchema };
const failure = z.string().regex(/^(CLOUD_BACKUP_[A-Z0-9_]+|local_sdk_error)$/);
const backupCursorSchema = z.discriminatedUnion("stage", [
  z.object({ ...common, stage: z.literal("directory"), after: z.string().nullable() }).strict(),
  z.object({ ...common, stage: z.literal("prepare"), stagingKey: cloudBackupStagingKeySchema.nullable() }).strict(),
  z.object({ ...upload, stage: z.literal("upload") }).strict(),
  z.object({ ...upload, stage: z.literal("verify-upload"), manifest: cloudBackupSnapshotManifestSchema }).strict(),
  z.object({ ...upload, stage: z.literal("commit-upload"), manifest: cloudBackupSnapshotManifestSchema }).strict(),
  z.object({ ...upload, stage: z.literal("cleanup-upload"), remaining: z.array(z.enum(["zip", "manifest"])).min(1).max(2), failure }).strict(),
  z.object({ ...common, stage: z.literal("scan"), after: z.string().nullable(), retained }).strict(),
  z.object({ ...common, stage: z.literal("prune"), after: z.string().nullable(), retained }).strict(),
  z.object({ ...common, ...page, stage: z.literal("inspect"), pass: z.enum(["scan", "prune"]), pending: page.pending.min(1) }).strict(),
  z.object({ ...common, ...page, stage: z.literal("remove"), entryId: snapshotKey.shape.id, part: z.enum(["zip", "manifest"]) }).strict(),
]);
export type CloudBackupCursor = z.infer<typeof backupCursorSchema>;
export type CloudBackupStep = { kind: "continue"; cursor: CloudBackupCursor; failure?: string } | { kind: "complete"; createdAt: string };

export function readCloudBackupCursor(raw: string): CloudBackupCursor | null {
  const value: unknown = JSON.parse(raw);
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return null;
  return backupCursorSchema.parse(value);
}

export async function runCloudBackupStep(input: {
  env: Env; userId: string; provider: CloudBackupProvider; client: CloudBackupPagedRemoteClient;
  cursor: CloudBackupCursor | null; retention: number; now: Date; budget: CronBudget;
}): Promise<CloudBackupStep> {
  const { client, cursor, budget } = input;
  if (!cursor) return { kind: "continue", cursor: { stage: "directory", id: snapshotId(input.now), createdAt: input.now.toISOString(), after: null } };
  budget.requireSql(3);
  const identity = { id: cursor.id, createdAt: cursor.createdAt };
  const owner = { userId: input.userId, provider: input.provider, id: cursor.id };
  if (cursor.stage === "prepare") {
    const prepared = await prepareCloudBackupAssets({ env: input.env, owner, exportedAt: new Date(cursor.createdAt), stagingKey: cursor.stagingKey, budget });
    return { kind: "continue", cursor: { ...identity, stage: prepared.complete ? "upload" : "prepare", stagingKey: prepared.stagingKey } };
  }
  // 一片只做一个远端操作；认证握手与重定向都在传输层按实际请求计入同一预算。
  if (cursor.stage === "directory") {
    const after = await client.prepareDirectory(cursor.after, 1);
    return { kind: "continue", cursor: after === null ? { ...identity, stage: "prepare", stagingKey: null } : { ...cursor, after } };
  }
  if (cursor.stage === "upload") {
    budget.consumeStorage(1);
    const content = await readCloudBackupStaging(input.env, owner, cursor.stagingKey, "zip", CLOUD_BACKUP_MAX_SNAPSHOT_BYTES);
    const payload = await cloudBackupPayloadFromZip(content, cursor.id, new Date(cursor.createdAt));
    budget.requireSql(3);
    await client.writeSnapshot(payload.filename, payload.content);
    return { kind: "continue", cursor: { ...cursor, stage: "verify-upload", manifest: payload.manifest } };
  }
  if (cursor.stage === "verify-upload" || cursor.stage === "commit-upload") {
    try {
      if (cursor.stage === "verify-upload") {
        await client.verifySnapshot(cursor.manifest);
        return { kind: "continue", cursor: { ...cursor, stage: "commit-upload" } };
      }
      await client.writeManifest(cursor.manifest);
      return { kind: "continue", cursor: { ...identity, stage: "scan", after: null, retained: [] } };
    } catch (error) {
      if (error instanceof CronBudgetExceeded) throw error;
      // ZIP已写入的失败必须先清理；原始阶段码随游标保存，后续清理失败不能覆盖它。
      const failure = persistedCloudBackupErrorMessage(error);
      return { kind: "continue", failure, cursor: { ...identity, stagingKey: cursor.stagingKey, stage: "cleanup-upload", failure,
        remaining: cursor.stage === "verify-upload" ? ["zip"] : ["zip", "manifest"] } };
    }
  }
  if (cursor.stage === "cleanup-upload") {
    const [part, ...remaining] = cursor.remaining;
    if (!part) throw new Error("CLOUD_BACKUP_CURSOR_INVALID");
    try { await client.deleteSnapshotFile(cursor.id, part); } catch (error) {
      if (error instanceof CronBudgetExceeded) throw error;
      // 与手动备份相同，清理只尝试一次并保留主错误；不能在不可删除的对象上永久挡住下一次上传。
      console.warn("cloud_backup_cleanup_failed", { event: "cloud_backup_cleanup_failed", provider: input.provider, part, code: persistedCloudBackupErrorMessage(error) });
    }
    return { kind: "continue", failure: cursor.failure, cursor: remaining.length > 0 ? { ...cursor, remaining }
      : { ...identity, stage: "upload", stagingKey: cursor.stagingKey } };
  }
  if (cursor.stage === "scan" || cursor.stage === "prune") {
    const result = await client.listManifestPage(cursor.after, BACKUP_PAGE_SIZE);
    return advanceRetention(identity, cursor.stage, result.cursor, cursor.retained, result.keys);
  }
  if (cursor.stage === "inspect") {
    const [key, ...pending] = cursor.pending;
    if (key === undefined) throw new Error("CLOUD_BACKUP_CURSOR_INVALID");
    const { id, createdAt } = await client.readManifest(key);
    const item = snapshotKey.parse({ id, createdAt });
    if (cursor.pass === "scan") {
      const newest = [...cursor.retained, item].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const keep = [...new Map(newest.map((entry) => [entry.id, entry])).values()].slice(0, input.retention);
      // 完整验证第一遍的所有manifest后才允许删除；坏的后续页不能导致旧备份提前消失。
      return advanceRetention(identity, "scan", cursor.after, keep, pending);
    }
    // 保留本次上传和两遍间新增的较新快照。删除ZIP/manifest分别提交，断点后不会重扫整页。
    if (item.id !== cursor.id && !cursor.retained.some((entry) => entry.id === item.id) && Date.parse(item.createdAt) <= Date.parse(cursor.createdAt)) {
      return { kind: "continue", cursor: { ...identity, stage: "remove", after: cursor.after, retained: cursor.retained, pending, entryId: item.id, part: "zip" } };
    }
    return advanceRetention(identity, "prune", cursor.after, cursor.retained, pending);
  }
  await client.deleteSnapshotFile(cursor.entryId, cursor.part);
  return cursor.part === "zip" ? { kind: "continue", cursor: { ...cursor, part: "manifest" } }
    : advanceRetention(identity, "prune", cursor.after, cursor.retained, cursor.pending);
}

function advanceRetention(identity: z.infer<typeof snapshotKey>, pass: "scan" | "prune", after: string | null, retained: RetainedSnapshots, pending: string[]): CloudBackupStep {
  if (pending.length > 0) return { kind: "continue", cursor: { ...identity, stage: "inspect", pass, after, retained, pending } };
  if (after !== null) return { kind: "continue", cursor: { ...identity, stage: pass, after, retained } };
  return pass === "scan" ? { kind: "continue", cursor: { ...identity, stage: "prune", after: null, retained } } : { kind: "complete", createdAt: identity.createdAt };
}
