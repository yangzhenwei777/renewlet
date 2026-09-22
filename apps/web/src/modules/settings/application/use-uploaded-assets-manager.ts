import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { assetInUseDetailsSchema, type AssetInUseDetails, type UploadedAsset } from "@/lib/api/schemas/media";
import { toast } from "@/components/ui/sonner";
import {
  invalidateUploadedAssetsQueries,
  removeUploadedAssetFromQueryCache,
  useUploadedAssetsByKind,
} from "@/hooks/use-uploaded-assets";
import { assetService } from "@/services/asset-service";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { useI18n } from "@/i18n/I18nProvider";
import type { SettingsReadState } from "./settings-read-state";

interface UploadedAssetKindController {
  readState: SettingsReadState<UploadedAsset[]>;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => Promise<void>;
}

interface AssetDeleteError {
  assetId: string;
  message: string;
}

export interface UploadedAssetsManagerController {
  logo: UploadedAssetKindController;
  icon: UploadedAssetKindController;
  deleteError: AssetDeleteError | null;
  deletingAssetId: string | null;
  deleteAsset: (asset: UploadedAsset) => Promise<boolean>;
}

// 设置页资产管理器只编排 UI 状态和 React Query 缓存；owner 校验、引用阻止和底层文件清理由服务端负责。
export function useUploadedAssetsManager(): UploadedAssetsManagerController {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const logo = useUploadedAssetsByKind("logo", { enabled: true });
  const icon = useUploadedAssetsByKind("icon", { enabled: true });
  const [deletingAssetId, setDeletingAssetId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<AssetDeleteError | null>(null);

  const deleteAsset = useCallback(async (asset: UploadedAsset) => {
    if (deletingAssetId) return false;
    setDeletingAssetId(asset.id);
    setDeleteError(null);
    try {
      await assetService.delete(asset.id);
      // 后端已确认删除成功后再做本地缓存剔除；ASSET_IN_USE 不做乐观更新，避免隐藏仍被引用的资产。
      removeUploadedAssetFromQueryCache(queryClient, asset);
      await invalidateUploadedAssetsQueries(queryClient, asset.kind);
      toast.success(t("settings.uploadedIconsDeleted", {
        name: assetLabel(asset, t("settings.uploadedIconsUnnamedAsset")),
      }));
      return true;
    } catch (error: unknown) {
      const fallback = t("settings.uploadedIconsDeleteFailedDescription");
      const message = assetDeleteErrorMessage(error, fallback, t);
      setDeleteError({ assetId: asset.id, message });
      toast.error(t("settings.uploadedIconsDeleteFailed"), { description: message });
      return false;
    } finally {
      setDeletingAssetId(null);
    }
  }, [deletingAssetId, queryClient, t]);

  return {
    logo: uploadedAssetKindController(logo),
    icon: uploadedAssetKindController(icon),
    deleteError,
    deletingAssetId,
    deleteAsset,
  };
}

function uploadedAssetKindController(
  query: ReturnType<typeof useUploadedAssetsByKind>,
): UploadedAssetKindController {
  return {
    readState: {
      data: query.hasData ? query.assets : undefined,
      hasData: query.hasData,
      error: query.error,
      isInitialLoading: query.isInitialLoading,
      isRefreshing: query.isRefreshing,
      retry: query.refresh,
    },
    hasMore: query.hasMore,
    isLoadingMore: query.isLoadingMore,
    loadMore: query.loadMore,
  };
}

function assetInUseDetails(error: unknown): AssetInUseDetails | null {
  if (!(error instanceof ApiError) || error.code !== "ASSET_IN_USE") return null;
  // Go 和 Cloudflare 都把引用计数放在 error.details；解析失败时回落通用错误，不猜测阻塞来源。
  const parsed = assetInUseDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data : null;
}

function assetDeleteErrorMessage(
  error: unknown,
  fallback: string,
  t: ReturnType<typeof useI18n>["t"],
): string {
  const details = assetInUseDetails(error);
  if (details) {
    if (details.subscriptionLogoCount > 0 && details.paymentMethodIconCount > 0) {
      return t("settings.uploadedIconsDeleteBlockedByBoth", {
        subscriptionCount: details.subscriptionLogoCount,
        paymentMethodCount: details.paymentMethodIconCount,
      });
    }
    if (details.paymentMethodIconCount > 0) {
      return t("settings.uploadedIconsDeleteBlockedByPaymentMethods", { count: details.paymentMethodIconCount });
    }
    return t("settings.uploadedIconsDeleteBlockedBySubscriptions", { count: details.subscriptionLogoCount });
  }
  return getDisplayErrorMessage(error, fallback);
}

function assetLabel(asset: UploadedAsset, fallback: string): string {
  return asset.originalName?.trim() || fallback;
}
