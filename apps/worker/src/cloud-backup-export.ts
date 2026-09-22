import { customConfigSchema } from "@renewlet/shared/schemas/custom-config";
import {
  CLOUD_BACKUP_MAX_SNAPSHOT_BYTES,
  cloudBackupSnapshotManifestSchema,
  type CloudBackupSnapshotManifest,
} from "@renewlet/shared/schemas/cloud-backup";
import {
  RENEWLET_EXPORT_SCHEMA_VERSION,
  renewletExportManifestV1Schema,
  renewletExportV1Schema,
  toRenewletExportSettingsV1,
  type RenewletExportAsset,
  type RenewletExportMissingAsset,
  type RenewletExportMissingAssetReason,
  type RenewletExportMissingAssetReference,
} from "@renewlet/shared/schemas/import-export";
import { getAsset, getCustomConfig, getSettings, listSubscriptions, toApiSubscription } from "./db";
import { sanitizeSettingsForCloudBackup } from "./cloud-backup-sanitize";
import { sha256Hex, snapshotId } from "./cloud-backup-remote";
import { extensionFromMime, privateAssetIdFromLogo } from "./cloud-backup-utils";
import { listExchangeRateSnapshots } from "./exchange-rate-snapshots";
import { createStoredZipFromSources, type StoredZipSource } from "./zip-store";
import type { Env } from "./types";

const textEncoder = new TextEncoder();
// 导出资产必须保持上传同一 2MiB 上限；整包 16MiB 约束不能让旧大对象绕过恢复上传校验。
const MAX_EXPORT_ASSET_BYTES = 2 * 1024 * 1024;

export type CloudBackupSnapshotPayload = {
  content: Uint8Array;
  id: string;
  filename: string;
  manifest: CloudBackupSnapshotManifest;
};

type ExportAsset = Omit<RenewletExportAsset, "sizeBytes"> & {
  sizeBytes: number;
  r2Key: string;
};

type ExportAssetReadResult =
  | { ok: true; asset: ExportAsset }
  | { ok: false; reason: RenewletExportMissingAssetReason };

type ExportAssetReference = {
  assetId: string;
  path: string;
  reference: RenewletExportMissingAssetReference;
  referenceId: string;
};

type ExportAssetCollector = {
  assets: ExportAsset[];
  assetById: Map<string, ExportAsset>;
  missingAssets: RenewletExportMissingAsset[];
};

export async function buildCloudBackupSnapshotPayload(env: Env, userId: string): Promise<CloudBackupSnapshotPayload> {
  const { content, exportedAt } = await buildCloudBackupExportZip(env, userId);
  if (content.length > CLOUD_BACKUP_MAX_SNAPSHOT_BYTES) throw new Error("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE");
  const id = snapshotId(exportedAt);
  const filename = `${id}.zip`;
  const manifest = cloudBackupSnapshotManifestSchema.parse({
    kind: "renewlet-cloud-backup-snapshot",
    schemaVersion: 1,
    id,
    filename,
    createdAt: exportedAt.toISOString(),
    sizeBytes: content.length,
    sha256: await sha256Hex(content),
    exportKind: "renewlet-export",
    exportSchemaVersion: RENEWLET_EXPORT_SCHEMA_VERSION,
  });
  return { content, id, filename, manifest };
}

export async function buildCloudBackupExportZip(env: Env, userId: string): Promise<{ content: Uint8Array; exportedAt: Date }> {
  const startedAt = performance.now();
  const exportedAt = new Date();
  const collector: ExportAssetCollector = { assets: [], assetById: new Map(), missingAssets: [] };
  const subscriptions = await listSubscriptions(env, userId);
  const exportSubscriptions = [];
  for (const row of subscriptions) {
    const subscription = { ...toApiSubscription(row) };
    const assetId = privateAssetIdFromLogo(subscription.logo ?? null);
    if (assetId && subscription.logo) {
      const assetPath = await resolveExportAsset(env, userId, collector, {
        assetId,
        path: subscription.logo,
        reference: "subscription.logo",
        referenceId: subscription.id,
      });
      if (assetPath) subscription.logo = assetPath;
      else delete subscription.logo;
    }
    exportSubscriptions.push(subscription);
  }
  const customConfig = await buildExportCustomConfig(env, userId, collector);
  // 云备份使用业务恢复 allowlist 组包；settings 必须经过 shared v1 投影，避免 Worker 与浏览器互导漂移。
  // sessions/MFA/passkey/tickets 和 R2 系统密钥对象都不进入 ZIP。
  const payload = renewletExportV1Schema.parse({
    kind: "renewlet-export",
    schemaVersion: RENEWLET_EXPORT_SCHEMA_VERSION,
    exportedAt: exportedAt.toISOString(),
    data: {
      subscriptions: exportSubscriptions,
      settings: toRenewletExportSettingsV1(sanitizeSettingsForCloudBackup(await getSettings(env, userId))),
      customConfig,
      exchangeRateSnapshots: await listExchangeRateSnapshots(env, userId),
      ...(collector.assets.length > 0
        ? { assets: collector.assets.map(({ r2Key: _r2Key, ...asset }) => asset) }
        : {}),
    },
  });
  const manifest = renewletExportManifestV1Schema.parse({
    kind: payload.kind,
    schemaVersion: payload.schemaVersion,
    exportedAt: payload.exportedAt,
    subscriptions: payload.data.subscriptions.length,
    assets: collector.assets.length,
    // 缺失详情只保留业务引用和原因枚举，不能把 D1/R2 key、raw error 或对象存储路径写进备份包。
    missingAssets: collector.missingAssets,
  });
  const payloadJson = JSON.stringify(payload, null, 2);
  const manifestJson = JSON.stringify(manifest, null, 2);
  const sources: StoredZipSource[] = [
    ...collector.assets.map((asset) => ({
      name: asset.path,
      size: asset.sizeBytes,
      date: exportedAt,
      load: async () => await readExportAssetContent(env, asset),
    })),
    { name: "data.json", size: utf8ByteLength(payloadJson), date: exportedAt, text: payloadJson },
    { name: "manifest.json", size: utf8ByteLength(manifestJson), date: exportedAt, text: manifestJson },
  ];
  const content = await createStoredZipFromSources(sources, exportedAt, CLOUD_BACKUP_MAX_SNAPSHOT_BYTES);
  console.info("cloud_backup_snapshot_resources", {
    event: "cloud_backup_snapshot_resources",
    entries: sources.length,
    assetBytes: collector.assets.reduce((total, asset) => total + asset.sizeBytes, 0),
    zipBytes: content.byteLength,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  });
  return { content, exportedAt };
}

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export async function verifySnapshotBytes(content: Uint8Array, manifest: CloudBackupSnapshotManifest): Promise<boolean> {
  if (manifest.kind !== "renewlet-cloud-backup-snapshot" || manifest.schemaVersion !== 1) return false;
  if (manifest.sizeBytes !== content.length) return false;
  return (await sha256Hex(content)) === manifest.sha256.toLowerCase();
}

async function buildExportCustomConfig(env: Env, userId: string, collector: ExportAssetCollector) {
  const config = customConfigSchema.parse(await getCustomConfig(env, userId));
  return {
    ...config,
    paymentMethods: await Promise.all(config.paymentMethods.map(async (paymentMethod) => {
      const assetId = privateAssetIdFromLogo(paymentMethod.icon ?? null);
      if (!assetId || !paymentMethod.icon) return paymentMethod;
      const assetPath = await resolveExportAsset(env, userId, collector, {
        assetId,
        path: paymentMethod.icon,
        reference: "customConfig.paymentMethods.icon",
        referenceId: paymentMethod.id,
      });
      if (assetPath) return { ...paymentMethod, icon: assetPath };
      const { icon: _icon, ...rest } = paymentMethod;
      return rest;
    })),
  };
}

async function resolveExportAsset(env: Env, userId: string, collector: ExportAssetCollector, reference: ExportAssetReference): Promise<string | null> {
  const existing = collector.assetById.get(reference.assetId);
  if (existing) return existing.path;
  const result = await readExportAsset(env, userId, reference.assetId);
  if (!result.ok) {
    collector.missingAssets.push({
      assetId: reference.assetId,
      path: reference.path,
      reference: reference.reference,
      referenceId: reference.referenceId,
      reason: result.reason,
    });
    return null;
  }
  collector.assetById.set(reference.assetId, result.asset);
  collector.assets.push(result.asset);
  return result.asset.path;
}

async function readExportAsset(env: Env, userId: string, assetId: string): Promise<ExportAssetReadResult> {
  try {
    // D1 asset metadata 是 owner 和 R2 key 的事实来源；R2 对象缺失只让引用进入 manifest 审计，不阻断整份快照。
    const row = await getAsset(env, userId, assetId);
    if (!row) return { ok: false, reason: "not_found" };
    const object = await env.ASSETS_BUCKET.head(row.r2_key);
    if (!object) return { ok: false, reason: "file_missing" };
    if (row.size_bytes !== null && row.size_bytes > MAX_EXPORT_ASSET_BYTES) return { ok: false, reason: "too_large" };
    if (object.size > MAX_EXPORT_ASSET_BYTES) return { ok: false, reason: "too_large" };
    if (row.size_bytes !== null && row.size_bytes !== object.size) return { ok: false, reason: "read_failed" };
    const mimeType = row.mime_type ?? object.httpMetadata?.contentType ?? "application/octet-stream";
    return {
      ok: true,
      asset: {
        id: assetId,
        path: `assets/${assetId}${extensionFromMime(mimeType, row.original_name ?? "")}`,
        ...(row.original_name ? { originalName: row.original_name } : {}),
        mimeType,
        sizeBytes: object.size,
        r2Key: row.r2_key,
      },
    };
  } catch {
    return { ok: false, reason: "read_failed" };
  }
}

async function readExportAssetContent(env: Env, asset: ExportAsset): Promise<Uint8Array> {
  const object = await env.ASSETS_BUCKET.get(asset.r2Key);
  if (!object) throw new Error("CLOUD_BACKUP_ASSET_MISSING");
  const content = new Uint8Array(await object.arrayBuffer());
  if (content.length > MAX_EXPORT_ASSET_BYTES) throw new Error("CLOUD_BACKUP_ASSET_TOO_LARGE");
  if (content.length !== asset.sizeBytes) throw new Error("CLOUD_BACKUP_ASSET_SIZE_MISMATCH");
  return content;
}
