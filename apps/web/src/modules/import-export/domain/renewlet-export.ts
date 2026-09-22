import {
  RENEWLET_EXPORT_SCHEMA_VERSION,
  renewletExportManifestV1Schema,
  renewletExportV1Schema,
  type RenewletExportAsset,
  type RenewletExportMissingAsset,
  type RenewletExportMissingAssetReason,
  type RenewletExportMissingAssetReference,
} from "@/lib/api/schemas/import-export";
import type { ExchangeRateSnapshotV1 } from "@/lib/api/schemas/exchange-rates";
import { MAX_IMAGE_BYTES } from "@/lib/upload-constraints";
import { runWorkerJob } from "@/lib/workers/run-worker-job";
import type { WorkerJobProgress } from "@/lib/workers/job-protocol";
import { downloadFile } from "@/shared/browser/download-file";
import type { CustomConfig } from "@/types/config";
import type { AppSettings, Subscription } from "@/types/subscription";
import {
  privateAssetIdFromLogo,
  sanitizeSettingsForExport,
  subscriptionToExportRow,
} from "./import-export-model";
import type {
  RenewletExportWorkerEntry,
  RenewletExportWorkerPayload,
  RenewletExportWorkerResult,
} from "./renewlet-export-worker-contract";

/**
 * exportRenewletBackup 生成 Renewlet v1 ZIP 备份。
 *
 * data.json 是正式互导契约，manifest.json 只服务人工检查；私有资产会带认证读取后放入 assets/，
 * settings secret 默认剔除，只有用户显式选择时才进入备份。
 */
export async function exportRenewletBackup(options: {
  subscriptions: readonly Subscription[];
  settings: AppSettings;
  customConfig: CustomConfig;
  includeSecrets: boolean;
  exchangeRateSnapshots?: readonly ExchangeRateSnapshotV1[];
}, execution: {
  signal?: AbortSignal;
  onProgress?: (progress: WorkerJobProgress) => void;
} = {}) {
  const entries: RenewletExportWorkerEntry[] = [];
  const assets: RenewletExportAsset[] = [];
  const missingAssets: RenewletExportMissingAsset[] = [];
  // 同一私有资产可能被多个订阅/logo 或支付方式 icon 引用；读取和 ZIP 写入都按 assetId 去重。
  const assetReads = new Map<string, Promise<PrivateAssetReadResult>>();
  const assetMetadataById = new Map<string, RenewletExportAsset>();
  async function resolveAsset(reference: PrivateAssetReference): Promise<string | null> {
    const result = await readPrivateAssetForExport(reference.path, assetReads, execution.signal);
    if (!result.ok) {
      missingAssets.push(missingAssetFromReference(reference, result.reason));
      return null;
    }
    const existing = assetMetadataById.get(reference.assetId);
    if (existing) return existing.path;
    const path = `assets/${reference.assetId}${extensionFromMime(result.blob.type)}`;
    // ZIP Worker 只接收 string 或 transferable ArrayBuffer；资产在越过线程边界前统一成可转移所有权的二进制。
    entries.push({ name: path, data: await result.blob.arrayBuffer() });
    const metadata = { id: reference.assetId, path, mimeType: result.blob.type, sizeBytes: result.blob.size };
    assets.push(metadata);
    assetMetadataById.set(reference.assetId, metadata);
    return path;
  }
  const subscriptions = [];
  for (const subscription of options.subscriptions) {
    const row = subscriptionToExportRow(subscription);
    const logo = subscription.logo;
    const assetId = privateAssetIdFromLogo(logo);
    if (assetId && logo) {
      const path = await resolveAsset({
        assetId,
        path: logo,
        reference: "subscription.logo",
        referenceId: subscription.id,
      });
      if (path) {
        row.logo = path;
      } else {
        // data.json 是恢复事实源；跨账号不可读的私有代理路径只能进 manifest 审计，不能留给导入写库。
        delete row.logo;
      }
    }
    subscriptions.push(row);
  }
  const customConfig = {
    ...options.customConfig,
    paymentMethods: await Promise.all(options.customConfig.paymentMethods.map(async (paymentMethod) => {
      const assetId = privateAssetIdFromLogo(paymentMethod.icon);
      if (!assetId || !paymentMethod.icon) return paymentMethod;
      const path = await resolveAsset({
        assetId,
        path: paymentMethod.icon,
        reference: "customConfig.paymentMethods.icon",
        referenceId: paymentMethod.id,
      });
      if (path) return { ...paymentMethod, icon: path };
      // 支付方式 icon 与订阅 logo 同属私有资产引用，失败时同样从恢复事实源移除。
      const { icon: _icon, ...rest } = paymentMethod;
      return rest;
    })),
  };

  const exportedAt = new Date().toISOString();
  const data = renewletExportV1Schema.parse({
    kind: "renewlet-export",
    schemaVersion: RENEWLET_EXPORT_SCHEMA_VERSION,
    exportedAt,
    data: {
      subscriptions,
      settings: sanitizeSettingsForExport(options.settings, options.includeSecrets),
      customConfig,
      exchangeRateSnapshots: [...(options.exchangeRateSnapshots ?? [])],
      assets,
    },
  });
  const manifest = renewletExportManifestV1Schema.parse({
    kind: data.kind,
    schemaVersion: data.schemaVersion,
    exportedAt: data.exportedAt,
    subscriptions: data.data.subscriptions.length,
    assets: assets.length,
    // missingAssets 是导出审计，不参与导入写库；失败资产已从 data.json 的 logo/icon 字段移除。
    missingAssets,
  });
  entries.push(
    { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
    { name: "data.json", data: JSON.stringify(data, null, 2) },
  );
  const transfer = entries.flatMap((entry) => entry.data instanceof ArrayBuffer ? [entry.data] : []);
  const result = await runWorkerJob<RenewletExportWorkerPayload, RenewletExportWorkerResult>({
    createWorker: () => new Worker(new URL("./renewlet-export-worker.ts", import.meta.url), { type: "module" }),
    payload: { entries },
    transfer,
    ...(execution.signal ? { signal: execution.signal } : {}),
    ...(execution.onProgress ? { onProgress: execution.onProgress } : {}),
  });
  const blob = new Blob([result.buffer], { type: "application/zip" });
  downloadFile(blob, `renewlet-export-v1-${exportedAt.slice(0, 10)}.zip`);
}

type PrivateAssetReference = {
  assetId: string;
  path: string;
  reference: RenewletExportMissingAssetReference;
  referenceId: string;
};

type PrivateAssetReadResult =
  | { ok: true; blob: Blob }
  | { ok: false; reason: RenewletExportMissingAssetReason };

async function readPrivateAssetForExport(
  url: string,
  cache: Map<string, Promise<PrivateAssetReadResult>>,
  signal?: AbortSignal,
): Promise<PrivateAssetReadResult> {
  const assetId = privateAssetIdFromLogo(url);
  if (!assetId) return { ok: false, reason: "not_found" };
  const cached = cache.get(assetId);
  if (cached) return cached;
  const promise = fetchPrivateAsset(url, signal);
  cache.set(assetId, promise);
  return promise;
}

async function fetchPrivateAsset(url: string, signal?: AbortSignal): Promise<PrivateAssetReadResult> {
  try {
    // 私有资产读取只信同源 HttpOnly cookie session；导出链路不能重新引入浏览器可见 bearer。
    const response = await fetch(url, {
      credentials: "include",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return { ok: false, reason: response.status === 404 ? "not_found" : "read_failed" };
    const blob = await response.blob();
    if (blob.size > MAX_IMAGE_BYTES) return { ok: false, reason: "too_large" };
    return { ok: true, blob };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, reason: "read_failed" };
  }
}

function missingAssetFromReference(reference: PrivateAssetReference, reason: RenewletExportMissingAssetReason): RenewletExportMissingAsset {
  return {
    assetId: reference.assetId,
    path: reference.path,
    reference: reference.reference,
    referenceId: reference.referenceId,
    reason,
  };
}

function extensionFromMime(mimeType: string): string {
  if (mimeType.includes("svg")) return ".svg";
  if (mimeType.includes("webp")) return ".webp";
  if (mimeType.includes("jpeg")) return ".jpg";
  if (mimeType.includes("png")) return ".png";
  if (mimeType.includes("icon")) return ".ico";
  return "";
}
