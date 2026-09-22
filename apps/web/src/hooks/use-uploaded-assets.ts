import { useCallback, useMemo, useState } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import type { UploadedAsset, UploadedAssetsPage, UploadKind } from "@/lib/api/schemas/media";
import { assetService } from "@/services/asset-service";

/**
 * 上传资产 React Query 缓存层。
 *
 * LogoPicker 和设置页资产管理共用同一资产事实源；这里只管理分页缓存和可见启用状态，
 * 删除引用阻止、owner 校验和 R2/PocketBase 清理由后端负责。
 */
export const uploadedAssetsQueryKeys = {
  all: ["uploaded-assets"] as const,
  byKind: (kind: UploadKind) => [...uploadedAssetsQueryKeys.all, "kind", kind] as const,
};

export interface UploadedAssetsByKindResult {
  assets: UploadedAsset[];
  error: Error | null;
  hasData: boolean;
  hasMore: boolean;
  isInitialLoading: boolean;
  isRefreshing: boolean;
  isLoadingMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  reset: () => void;
}

export function invalidateUploadedAssetsQueries(queryClient: QueryClient, kind?: UploadKind) {
  return queryClient.invalidateQueries({
    queryKey: kind ? uploadedAssetsQueryKeys.byKind(kind) : uploadedAssetsQueryKeys.all,
  });
}

export function removeUploadedAssetFromQueryCache(queryClient: QueryClient, asset: UploadedAsset) {
  queryClient.setQueryData<InfiniteData<UploadedAssetsPage, number>>(
    uploadedAssetsQueryKeys.byKind(asset.kind),
    (current) => {
      if (!current) return current;
      // 删除成功后只从对应 kind 的分页缓存剔除；其它 kind 和未加载页交给失效/刷新处理，避免假装全局一致。
      return {
        ...current,
        pages: current.pages.map((page) => ({
          ...page,
          items: page.items.filter((item) => item.id !== asset.id),
        })),
      };
    },
  );
}

export function useUploadedAssetsByKind(
  kind: UploadKind,
  options: { enabled?: boolean } = {},
): UploadedAssetsByKindResult {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(options.enabled ?? false);
  const query = useInfiniteQuery({
    queryKey: uploadedAssetsQueryKeys.byKind(kind),
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => assetService.list(kind, pageParam, signal),
    getNextPageParam: (lastPage) => lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
    enabled,
  });

  const assets = useMemo(() => {
    if (!enabled) return [];
    // 无限分页可能因 refetch 或并发 loadMore 产生重复页项；渲染前按 id 合并，避免 UI 出现重复删除按钮。
    return mergeAssets(query.data?.pages.flatMap((page) => page.items) ?? []);
  }, [enabled, query.data?.pages]);
  const error = query.error instanceof Error ? query.error : query.error ? new Error("Uploaded assets load failed") : null;
  const hasData = enabled && query.data !== undefined;
  const isInitialLoading = enabled && !query.isFetched && query.isPending && query.isFetching && !query.isFetchingNextPage && !hasData;
  // 首次失败后的 refetch 仍无缓存，但必须算刷新以锁定重复重试，不能重新伪装成首次加载。
  const isRefreshing = enabled && query.isFetching && !query.isFetchingNextPage && !isInitialLoading;
  const isLoadingMore = enabled && query.isFetchingNextPage;

  const refresh = useCallback(async () => {
    setEnabled(true);
    if (!enabled) return;
    await query.refetch();
  }, [enabled, query]);

  const loadMore = useCallback(async () => {
    if (!enabled) {
      setEnabled(true);
      return;
    }
    if (!query.hasNextPage || query.isFetching || query.isFetchingNextPage) return;
    await query.fetchNextPage();
  }, [enabled, query]);

  const reset = useCallback(() => {
    setEnabled(false);
    // 只重置当前调用方的可见状态，不清全局缓存；设置页管理器和 LogoPicker 共享同一资产事实源。
    void queryClient.cancelQueries({ queryKey: uploadedAssetsQueryKeys.byKind(kind) });
  }, [kind, queryClient]);

  return {
    assets,
    error,
    hasData,
    hasMore: enabled && Boolean(query.hasNextPage),
    isInitialLoading,
    isRefreshing,
    isLoadingMore,
    refresh,
    loadMore,
    reset,
  };
}

function mergeAssets(items: UploadedAsset[]): UploadedAsset[] {
  const seen = new Set<string>();
  const merged: UploadedAsset[] = [];
  for (const asset of items) {
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    merged.push(asset);
  }
  return merged;
}
