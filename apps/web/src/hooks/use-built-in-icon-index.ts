import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { builtInIconIndexService } from "@/services/built-in-icon-index-service";
import type { BuiltInIconProvider } from "@renewlet/shared/built-in-icons";
import type { BuiltInIconIndexStatus } from "@/lib/api/schemas/media";

export const builtInIconIndexQueryKey = ["built-in-icon-index"] as const;
const BUILT_IN_ICON_REFRESH_POLL_MS = 3000;

function hasRunningBuiltInIconRefreshJob(status: BuiltInIconIndexStatus | undefined): boolean {
  return Boolean(status?.providers.some((provider) => provider.job?.status === "queued" || provider.job?.status === "running"));
}

export function useBuiltInIconIndexStatus(enabled: boolean) {
  return useQuery({
    queryKey: builtInIconIndexQueryKey,
    queryFn: ({ signal }) => builtInIconIndexService.status(signal),
    enabled,
    retry: false,
    staleTime: 60 * 1000,
    // Cloudflare refresh 只把任务入队；轮询跟随后端 job 终态停止，避免关闭弹层后本地 spinner 卡死。
    refetchInterval: (query) => hasRunningBuiltInIconRefreshJob(query.state.data) ? BUILT_IN_ICON_REFRESH_POLL_MS : false,
    refetchOnWindowFocus: false,
  });
}

export function useCheckBuiltInIconIndexProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: BuiltInIconProvider) => builtInIconIndexService.check(provider),
    onSuccess: (response) => {
      // provider 版本检查只更新索引状态缓存，不触碰 settings 草稿和未保存提示。
      queryClient.setQueryData(builtInIconIndexQueryKey, response.status);
    },
  });
}

export function useRefreshBuiltInIconIndexProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: BuiltInIconProvider) => builtInIconIndexService.refresh(provider),
    onSuccess: (response) => {
      // provider 刷新是管理员级索引动作；成功后只更新索引状态缓存，不触碰 settings 草稿。
      queryClient.setQueryData(builtInIconIndexQueryKey, response.status);
    },
  });
}
