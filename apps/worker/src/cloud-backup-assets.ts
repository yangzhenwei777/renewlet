import { z } from "zod";
import { CLOUD_BACKUP_MAX_SNAPSHOT_BYTES } from "@renewlet/shared/schemas/cloud-backup";
import { renewletExportV1Schema, renewletExportManifestV1Schema } from "@renewlet/shared/schemas/import-export";
import {
  cloudBackupExportAssetIds, createCloudBackupExportZip, readCloudBackupExportDraft,
  readExportAsset, readExportAssetContent, type ExportAssetReadResult,
} from "./cloud-backup-export";
import { readCloudBackupStaging, saveCloudBackupStaging, type CloudBackupStagingOwner } from "./cloud-backup-staging";
import { CronBudgetExceeded, type CronBudget } from "./cron-budget";
import type { Env } from "./types";

// 按资产数限制单片CPU工作；R2请求预算另行累计，不能只靠16MiB字节上限约束大量小对象。
export const CLOUD_BACKUP_ASSET_PAGE_SIZE = 50;
const HEADER_LENGTH_BYTES = 4;
const MAX_STAGING_BYTES = 2 * CLOUD_BACKUP_MAX_SNAPSHOT_BYTES;
const encoder = new TextEncoder();
const assetSchema = renewletExportV1Schema.shape.data.shape.assets.unwrap().element.extend({ sizeBytes: z.number().int().nonnegative(), r2Key: z.string() });
const stateSchema = z.object({
  version: z.literal(1),
  payload: renewletExportV1Schema,
  metadata: z.array(z.object({ id: z.string(), r2_key: z.string(), original_name: z.string().nullable(), mime_type: z.string().nullable(), size_bytes: z.number().nullable() })),
  completed: z.array(z.object({ id: z.string(), result: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), asset: assetSchema }),
    z.object({ ok: z.literal(false), reason: renewletExportManifestV1Schema.shape.missingAssets.element.shape.reason }),
  ]) })),
});
type AssetPreparation = z.infer<typeof stateSchema>;

export async function prepareCloudBackupAssets(input: {
  env: Env; owner: CloudBackupStagingOwner; exportedAt: Date; stagingKey: string | null; budget: CronBudget;
}): Promise<{ stagingKey: string; complete: boolean }> {
  const { env, owner, exportedAt, stagingKey, budget } = input;
  budget.requireSql(4);
  // 先为读旧对象/写新对象留额度；耗尽只能保留原游标，不能把剩余资产谎报为missing。
  budget.consumeStorage(2);
  const { state, bytes } = stagingKey
    ? decodeState(await readCloudBackupStaging(env, owner, stagingKey, "assets", MAX_STAGING_BYTES))
    : { state: { version: 1 as const, ...await readCloudBackupExportDraft(env, owner.userId, exportedAt), completed: [] }, bytes: new Uint8Array(0) };
  if (state.payload.exportedAt !== exportedAt.toISOString()) throw new Error("CLOUD_BACKUP_STAGING_INVALID");
  const ids = cloudBackupExportAssetIds(state.payload);
  const contents = readCompletedAssets(state, ids, bytes);
  const metadata = new Map(state.metadata.map((row) => [row.id, row]));
  let length = bytes.length;
  const start = state.completed.length;
  const end = Math.min(ids.length, start + CLOUD_BACKUP_ASSET_PAGE_SIZE, start + Math.floor(budget.remainingStorage / 2));
  if (end === start && end < ids.length) throw new CronBudgetExceeded("storage");
  // 两次请求属于同一资产，先一起预留，避免HEAD后预算耗尽而丢失当前页进展。
  budget.consumeStorage((end - start) * 2);
  for (const id of ids.slice(state.completed.length, end)) {
    const row = metadata.get(id);
    const result: ExportAssetReadResult = row ? await readExportAsset(env, row) : { ok: false, reason: "not_found" };
    if (result.ok) {
      if (length + result.asset.sizeBytes > CLOUD_BACKUP_MAX_SNAPSHOT_BYTES) throw new Error("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE");
      const asset = await readExportAssetContent(env, result.asset);
      contents.set(id, asset);
      length += asset.length;
    }
    state.completed.push({ id, result });
  }
  const complete = state.completed.length === ids.length;
  const output = complete ? await finishExport(state, contents) : encodeState(state, contents, length);
  return { stagingKey: await saveCloudBackupStaging(env, owner, output, complete ? "zip" : "assets"), complete };
}

function readCompletedAssets(state: AssetPreparation, ids: string[], bytes: Uint8Array): Map<string, Uint8Array> {
  const contents = new Map<string, Uint8Array>();
  let size = 0;
  for (const [index, item] of state.completed.entries()) {
    if (item.id !== ids[index] || (item.result.ok && item.result.asset.id !== item.id)) throw new Error("CLOUD_BACKUP_STAGING_INVALID");
    if (item.result.ok) {
      contents.set(item.id, bytes.subarray(size, size + item.result.asset.sizeBytes));
      size += item.result.asset.sizeBytes;
    }
  }
  if (size !== bytes.length) throw new Error("CLOUD_BACKUP_STAGING_INVALID");
  return contents;
}

async function finishExport(state: AssetPreparation, contents: Map<string, Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const results = new Map(state.completed.map((item) => [item.id, item.result]));
  // ZIP仍由同一个v1导出器生成；内部metadata/R2 key只用来续接，不能进入data.json或manifest。
  const { content } = await createCloudBackupExportZip(state.payload, async (id) => {
    const result = results.get(id);
    if (!result) throw new Error("CLOUD_BACKUP_STAGING_INVALID");
    return result;
  }, async (asset) => {
    const bytes = contents.get(asset.id);
    if (!bytes) throw new Error("CLOUD_BACKUP_STAGING_INVALID");
    return bytes;
  });
  return content;
}

function encodeState(state: AssetPreparation, contents: Map<string, Uint8Array>, assetBytes: number): Uint8Array<ArrayBuffer> {
  const header = encoder.encode(JSON.stringify(state));
  const size = HEADER_LENGTH_BYTES + header.length + assetBytes;
  if (size > MAX_STAGING_BYTES) throw new Error("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE");
  const output = new Uint8Array(size);
  new DataView(output.buffer).setUint32(0, header.length, true);
  output.set(header, HEADER_LENGTH_BYTES);
  // 旧资产是R2缓冲区的视图，新资产总量也受16MiB约束；只复制进最终检查点，不再分配满额临时缓冲区。
  let offset = HEADER_LENGTH_BYTES + header.length;
  for (const bytes of contents.values()) { output.set(bytes, offset); offset += bytes.length; }
  return output;
}

function decodeState(content: Uint8Array): { state: AssetPreparation; bytes: Uint8Array } {
  if (content.length < HEADER_LENGTH_BYTES) throw new Error("CLOUD_BACKUP_STAGING_INVALID");
  const end = HEADER_LENGTH_BYTES + new DataView(content.buffer, content.byteOffset).getUint32(0, true);
  if (end > content.length) throw new Error("CLOUD_BACKUP_STAGING_INVALID");
  const raw: unknown = JSON.parse(new TextDecoder().decode(content.subarray(HEADER_LENGTH_BYTES, end)));
  return { state: stateSchema.parse(raw), bytes: content.subarray(end) };
}
