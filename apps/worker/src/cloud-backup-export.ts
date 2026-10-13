import { customConfigSchema, type ApiCustomConfig } from "@renewlet/shared/schemas/custom-config";
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
  type RenewletExportV1,
  type RenewletExportMissingAsset,
  type RenewletExportMissingAssetReason,
  type RenewletExportMissingAssetReference,
} from "@renewlet/shared/schemas/import-export";
import { getOwnedAssetsByIds, getCustomConfig, getSettings, listSubscriptions, toApiSubscription, type OwnedAssetMetadata } from "./db";
import { sanitizeSettingsForCloudBackup } from "./cloud-backup-sanitize";
import { sha256Hex, snapshotId } from "./cloud-backup-remote";
import { extensionFromMime, privateAssetIdFromLogo } from "./cloud-backup-utils";
import { listExchangeRateSnapshots } from "./exchange-rate-snapshots";
import { createStoredZipFromSources, type StoredZipSource } from "./zip-store";
import type { Env } from "./types";
import type { CronBudget } from "./cron-budget";

const textEncoder = new TextEncoder();
// 导出资产必须保持上传同一 2MiB 上限；整包 16MiB 约束不能让旧大对象绕过恢复上传校验。
const MAX_EXPORT_ASSET_BYTES = 2 * 1024 * 1024;

export type CloudBackupSnapshotPayload = {
  content: Uint8Array;
  id: string;
  filename: string;
  manifest: CloudBackupSnapshotManifest;
};

export type ExportAsset = Omit<RenewletExportAsset, "sizeBytes"> & {
  sizeBytes: number;
  r2Key: string;
};

export type ExportAssetReadResult =
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
  read: (assetId: string) => Promise<ExportAssetReadResult>;
  reads: Map<string, ExportAssetReadResult>;
  missingAssets: RenewletExportMissingAsset[];
};

export async function buildCloudBackupSnapshotPayload(env: Env, userId: string, scheduled?: { id: string; exportedAt: Date; budget: CronBudget }): Promise<CloudBackupSnapshotPayload> {
  const { content, exportedAt } = await buildCloudBackupExportZip(env, userId, scheduled?.exportedAt, scheduled?.budget);
  return cloudBackupPayloadFromZip(content, scheduled?.id ?? snapshotId(exportedAt), exportedAt);
}

export async function cloudBackupPayloadFromZip(content: Uint8Array, id: string, exportedAt: Date): Promise<CloudBackupSnapshotPayload> {
  if (content.length > CLOUD_BACKUP_MAX_SNAPSHOT_BYTES) throw new Error("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE");
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

export async function buildCloudBackupExportZip(env: Env, userId: string, exportedAt = new Date(), budget?: CronBudget): Promise<{ content: Uint8Array; exportedAt: Date }> {
  const startedAt = performance.now();
  const { payload, metadata } = await readCloudBackupExportDraft(env, userId, exportedAt);
  const owned = new Map(metadata.map((row) => [row.id, row]));
  const { content, entries, assetBytes } = await createCloudBackupExportZip(payload, async (id) => {
    const row = owned.get(id);
    if (!row) return { ok: false, reason: "not_found" };
    budget?.consumeStorage(2);
    return readExportAsset(env, row);
  }, (asset) => readExportAssetContent(env, asset));
  console.info("cloud_backup_snapshot_resources", {
    event: "cloud_backup_snapshot_resources", entries, assetBytes, zipBytes: content.byteLength,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  });
  return { content, exportedAt };
}

export async function readCloudBackupExportDraft(env: Env, userId: string, exportedAt: Date) {
  const [subscriptions, settings, rawConfig, exchangeRateSnapshots] = await Promise.all([
    listSubscriptions(env, userId), getSettings(env, userId), getCustomConfig(env, userId), listExchangeRateSnapshots(env, userId),
  ]);
  // 持久续接也只冻结业务恢复allowlist；认证材料与系统R2对象不能进入中间快照。
  const payload: RenewletExportV1 = {
    kind: "renewlet-export", schemaVersion: RENEWLET_EXPORT_SCHEMA_VERSION, exportedAt: exportedAt.toISOString(),
    data: { subscriptions: subscriptions.map(toApiSubscription),
      settings: toRenewletExportSettingsV1(sanitizeSettingsForCloudBackup(settings)),
      customConfig: customConfigSchema.parse(rawConfig), exchangeRateSnapshots },
  };
  // metadata失败必须中止，不能记成资产缺失；跨账号引用不会获得R2 key。
  const metadata = await getOwnedAssetsByIds(env, userId, cloudBackupExportAssetIds(payload));
  return { payload, metadata };
}

export function cloudBackupExportAssetIds(payload: RenewletExportV1): string[] {
  return [...new Set([...payload.data.subscriptions.map((row) => row.logo),
    ...(payload.data.customConfig?.paymentMethods.map((method) => method.icon) ?? [])]
    .map((path) => privateAssetIdFromLogo(path ?? null)).filter((id): id is string => Boolean(id)))];
}

export async function createCloudBackupExportZip(
  draft: RenewletExportV1,
  read: ExportAssetCollector["read"],
  load: (asset: ExportAsset) => Promise<Uint8Array>,
): Promise<{ content: Uint8Array<ArrayBuffer>; entries: number; assetBytes: number }> {
  const exportedAt = new Date(draft.exportedAt);
  const collector: ExportAssetCollector = { assets: [], read, reads: new Map(), missingAssets: [] };
  const exportSubscriptions = [];
  for (const row of draft.data.subscriptions) {
    const subscription = { ...row };
    const assetId = privateAssetIdFromLogo(subscription.logo ?? null);
    if (assetId && subscription.logo) {
      const assetPath = await resolveExportAsset(collector, {
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
  const customConfig = draft.data.customConfig ? await buildExportCustomConfig(draft.data.customConfig, collector) : undefined;
  // 云备份使用业务恢复 allowlist 组包；settings 必须经过 shared v1 投影，避免 Worker 与浏览器互导漂移。
  // sessions/MFA/passkey/tickets 和 R2 系统密钥对象都不进入 ZIP。
  const payload = renewletExportV1Schema.parse({
    kind: "renewlet-export",
    schemaVersion: RENEWLET_EXPORT_SCHEMA_VERSION,
    exportedAt: exportedAt.toISOString(),
    data: {
      subscriptions: exportSubscriptions,
      settings: draft.data.settings,
      customConfig,
      exchangeRateSnapshots: draft.data.exchangeRateSnapshots,
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
      load: () => load(asset),
    })),
    { name: "data.json", size: utf8ByteLength(payloadJson), date: exportedAt, text: payloadJson },
    { name: "manifest.json", size: utf8ByteLength(manifestJson), date: exportedAt, text: manifestJson },
  ];
  const content = await createStoredZipFromSources(sources, exportedAt, CLOUD_BACKUP_MAX_SNAPSHOT_BYTES);
  return { content, entries: sources.length, assetBytes: collector.assets.reduce((sum, asset) => sum + asset.sizeBytes, 0) };
}

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export async function verifySnapshotBytes(content: Uint8Array, manifest: CloudBackupSnapshotManifest): Promise<boolean> {
  if (manifest.kind !== "renewlet-cloud-backup-snapshot" || manifest.schemaVersion !== 1) return false;
  if (manifest.sizeBytes !== content.length) return false;
  return (await sha256Hex(content)) === manifest.sha256.toLowerCase();
}

async function buildExportCustomConfig(config: ApiCustomConfig, collector: ExportAssetCollector) {
  const paymentMethods = [];
  // 同一资产可被多个支付方式引用；顺序解析与共享结果缓存保证每个对象只校验和入包一次。
  for (const paymentMethod of config.paymentMethods) {
    const assetId = privateAssetIdFromLogo(paymentMethod.icon ?? null);
    if (!assetId || !paymentMethod.icon) {
      paymentMethods.push(paymentMethod);
      continue;
    }
    const assetPath = await resolveExportAsset(collector, {
      assetId, path: paymentMethod.icon, reference: "customConfig.paymentMethods.icon", referenceId: paymentMethod.id,
    });
    if (assetPath) paymentMethods.push({ ...paymentMethod, icon: assetPath });
    else {
      const { icon: _icon, ...rest } = paymentMethod;
      paymentMethods.push(rest);
    }
  }
  return { ...config, paymentMethods };
}

async function resolveExportAsset(collector: ExportAssetCollector, reference: ExportAssetReference): Promise<string | null> {
  let result = collector.reads.get(reference.assetId);
  if (!result) {
    result = await collector.read(reference.assetId);
    collector.reads.set(reference.assetId, result);
    if (result.ok) collector.assets.push(result.asset);
  }
  if (result.ok) return result.asset.path;
  collector.missingAssets.push({ ...reference, reason: result.reason });
  return null;
}

export async function readExportAsset(env: Env, row: OwnedAssetMetadata): Promise<ExportAssetReadResult> {
  try {
    // D1 asset metadata 是 owner 和 R2 key 的事实来源；R2 对象缺失只让引用进入 manifest 审计，不阻断整份快照。
    const object = await env.ASSETS_BUCKET.head(row.r2_key);
    if (!object) return { ok: false, reason: "file_missing" };
    if (row.size_bytes !== null && row.size_bytes > MAX_EXPORT_ASSET_BYTES) return { ok: false, reason: "too_large" };
    if (object.size > MAX_EXPORT_ASSET_BYTES) return { ok: false, reason: "too_large" };
    if (row.size_bytes !== null && row.size_bytes !== object.size) return { ok: false, reason: "read_failed" };
    const mimeType = row.mime_type ?? object.httpMetadata?.contentType ?? "application/octet-stream";
    return {
      ok: true,
      asset: {
        id: row.id,
        path: `assets/${row.id}${extensionFromMime(mimeType, row.original_name ?? "")}`,
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

export async function readExportAssetContent(env: Env, asset: ExportAsset): Promise<Uint8Array> {
  const object = await env.ASSETS_BUCKET.get(asset.r2Key);
  if (!object) throw new Error("CLOUD_BACKUP_ASSET_MISSING");
  const content = new Uint8Array(await object.arrayBuffer());
  if (content.length > MAX_EXPORT_ASSET_BYTES) throw new Error("CLOUD_BACKUP_ASSET_TOO_LARGE");
  if (content.length !== asset.sizeBytes) throw new Error("CLOUD_BACKUP_ASSET_SIZE_MISMATCH");
  return content;
}
