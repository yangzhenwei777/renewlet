/**
 * 已上传 Logo 资产列表 Hook。
 *
 * LogoPicker 保持“打开选择器才加载”的交互，但数据事实来自统一 uploaded-assets Query；
 * 上传/删除成功后的缓存失效会同步到设置页上传图标管理器。
 */
import { useUploadedAssetsByKind } from "@/hooks/use-uploaded-assets";
import type { UploadedAsset } from "@/services/asset-service";

export interface UseUploadedLogoAssetsResult {
  assets: UploadedAsset[];
  error: Error | null;
  hasLoaded: boolean;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  loadInitial: () => Promise<void>;
  loadMore: () => Promise<void>;
  reset: () => void;
}

export function useUploadedLogoAssets(): UseUploadedLogoAssetsResult {
  const uploadedLogos = useUploadedAssetsByKind("logo");

  return {
    assets: uploadedLogos.assets,
    error: uploadedLogos.error,
    hasLoaded: uploadedLogos.hasData,
    hasMore: uploadedLogos.hasMore,
    isLoading: uploadedLogos.isInitialLoading || uploadedLogos.isRefreshing,
    isLoadingMore: uploadedLogos.isLoadingMore,
    loadInitial: uploadedLogos.refresh,
    loadMore: uploadedLogos.loadMore,
    reset: uploadedLogos.reset,
  };
}
