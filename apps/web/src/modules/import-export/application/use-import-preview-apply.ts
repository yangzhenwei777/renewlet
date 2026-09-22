import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DeferredLogoAsset } from "@/components/import-logo-editor";
import {
  recomputePreviewForConflictMode,
  type PreviewFilter,
} from "@/components/import-preview-list";
import { toast } from "@/components/ui/sonner";
import { SETTINGS_QUERY_KEY } from "@/hooks/settings-query-key";
import { invalidateSubscriptionCollections, removeSubscriptionDetails } from "@/hooks/subscription-query-cache";
import { invalidateUploadedAssetsQueries } from "@/hooks/use-uploaded-assets";
import { useI18n } from "@/i18n/I18nProvider";
import { getDisplayErrorMessage } from "@/lib/display-error";
import {
  importApplyPayloadSchema,
  importPayloadSchema,
  type ImportApplyResponse,
  type ImportConflictMode,
  type ImportPayload,
  type ImportPreviewResponse,
} from "@/lib/api/schemas/import-export";
import type { PreparedImport } from "@/modules/import-export/domain/import-export-model";
import {
  resolveImportAssets,
  updatePreparedSubscriptionLogo,
} from "@/modules/import-export/domain/wallos-import";
import { importExportService } from "@/services/import-export-service";
import { resolveAutoLogosForPreparedImport } from "@/modules/import-export/domain/auto-logo-resolve";

interface UseImportPreviewApplyOptions {
  onApplied: () => void;
}

function parseApplyPayload(value: unknown): ImportPayload {
  return importPayloadSchema.parse(value) as ImportPayload;
}

function parseApplyResult(value: unknown): ImportApplyResponse {
  return importApplyPayloadSchema.parse(value) as ImportApplyResponse;
}

class ImportAssetUploadError extends Error {
  constructor(readonly cause: unknown) {
    super("IMPORT_ASSET_UPLOAD_FAILED");
    this.name = "ImportAssetUploadError";
  }
}

export function useImportPreviewApply({ onApplied }: UseImportPreviewApplyOptions) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [prepared, setPrepared] = useState<PreparedImport | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [conflictMode, setConflictMode] = useState<ImportConflictMode>("skip");
  const [previewFilter, setPreviewFilter] = useState<PreviewFilter>("all");
  const [skippedIndexes, setSkippedIndexes] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [assetProgress, setAssetProgress] = useState<{ done: number; total: number } | null>(null);
  const [applyProgress, setApplyProgress] = useState<{ done: number; total: number } | null>(null);

  const resetImportPreview = useCallback(() => {
    setPrepared(null);
    setPreview(null);
    setConflictMode("skip");
    setPreviewFilter("all");
    setSkippedIndexes(new Set());
    setError(null);
    setApplying(false);
    setAssetProgress(null);
    setApplyProgress(null);
  }, []);

  const previewPrepared = useCallback(async (
    nextPrepared: PreparedImport,
    nextConflictMode: ImportConflictMode,
    signal: AbortSignal,
  ) => {
    const preparedWithAutoLogos = await resolveAutoLogosForPreparedImport(nextPrepared, signal);
    signal.throwIfAborted();
    const result = await importExportService.preview(preparedWithAutoLogos.payload, nextConflictMode, signal);
    signal.throwIfAborted();
    setPrepared(preparedWithAutoLogos);
    setPreview(result);
    setPreviewFilter("all");
    setSkippedIndexes(new Set());
    setAssetProgress(null);
    setApplyProgress(null);
  }, []);

  const handleConflictModeChange = useCallback((value: ImportConflictMode) => {
    setConflictMode(value);
    // 冲突模式只影响已有同源项的 action/summary；预览结果本地重算，执行时服务端仍会重新校验整包。
    setPreview((current) => current ? recomputePreviewForConflictMode(current, value, skippedIndexes) : current);
  }, [skippedIndexes]);

  const handleLogoChange = useCallback((index: number, value: string | null, asset?: DeferredLogoAsset) => {
    setPrepared((current) => current
      ? updatePreparedSubscriptionLogo(
        current,
        index,
        value,
        asset ? { blob: asset.blob, filename: asset.filename, previewUrl: asset.previewUrl } : undefined,
      )
      : current);
  }, []);

  const handleSkipChange = useCallback((index: number, skipped: boolean) => {
    const nextSkippedIndexes = new Set(skippedIndexes);
    if (skipped) {
      nextSkippedIndexes.add(index);
    } else {
      nextSkippedIndexes.delete(index);
    }
    // 单条跳过只改本地预览 action；apply 会携带 skipIndexes 让服务端重新预览，避免前端 action 被当成事实。
    setSkippedIndexes(nextSkippedIndexes);
    setPreview((current) => current ? recomputePreviewForConflictMode(current, conflictMode, nextSkippedIndexes) : current);
  }, [conflictMode, skippedIndexes]);

  const handleApply = useCallback(async () => {
    if (!prepared || !preview || preview.summary.errors > 0) return;
    setApplying(true);
    setError(null);
    setAssetProgress(null);
    setApplyProgress(null);
    try {
      const skipIndexList = [...skippedIndexes].sort((a, b) => a - b);
      const effectivePreview = recomputePreviewForConflictMode(preview, conflictMode, skippedIndexes);
      // 资产上传属于 apply 阶段：预览不产生写入，且 skip 行不会上传 staged/zip Logo。
      const resolvedAssets = await resolveImportAssets(prepared, effectivePreview.items, (done, total) => setAssetProgress({ done, total }))
        .catch((assetError: unknown) => {
          throw new ImportAssetUploadError(assetError);
        });
      const payload = parseApplyPayload(resolvedAssets.payload);
      const result = parseApplyResult(await importExportService.applyChunked(payload, conflictMode, skipIndexList, (done, total) => setApplyProgress({ done, total })));
      // 导入资产上传只影响 logo 分页缓存；按上传结果精确失效，避免无 Logo 导入刷新资产列表。
      const assetInvalidations = resolvedAssets.uploadedLogoCount > 0
        ? [invalidateUploadedAssetsQueries(queryClient, "logo")]
        : [];
      const iconAssetInvalidations = resolvedAssets.uploadedIconCount > 0
        ? [invalidateUploadedAssetsQueries(queryClient, "icon")]
        : [];
      // 导入可能同时写订阅、设置和自定义配置；成功后统一失效，避免页面继续展示导入前缓存。
      // 导入可能替换任意 id 的完整记录；detail cache 无法局部证明有效，必须整体清空。
      removeSubscriptionDetails(queryClient);
      await Promise.all([
        invalidateSubscriptionCollections(queryClient),
        queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ["custom-config"] }),
        ...assetInvalidations,
        ...iconAssetInvalidations,
      ]);
      toast.success(t("import.successResult", {
          creates: result.summary.creates,
          replaces: result.summary.replaces,
          skips: result.summary.skips,
        }));
      onApplied();
    } catch (err) {
      const message = err instanceof ImportAssetUploadError
        ? t("import.assetUploadFailed")
        : getDisplayErrorMessage(err, t("import.applyFailed"));
      setError(message);
      toast.error(message);
    } finally {
      setApplying(false);
    }
  }, [conflictMode, onApplied, prepared, preview, queryClient, skippedIndexes, t]);

  return {
    prepared,
    preview,
    conflictMode,
    previewFilter,
    skippedIndexes,
    error,
    applying,
    assetProgress,
    applyProgress,
    setError,
    setPreviewFilter,
    resetImportPreview,
    previewPrepared,
    handleConflictModeChange,
    handleLogoChange,
    handleSkipChange,
    handleApply,
  };
}
