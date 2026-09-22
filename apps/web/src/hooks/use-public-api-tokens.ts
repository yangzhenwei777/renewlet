import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { publicApiService } from "@/services/public-api-service";

const PUBLIC_API_TOKENS_QUERY_KEY = ["public-api-tokens"] as const;

/** Public API token 是当前账号的低权限 bearer 列表；React Query 缓存不保存明文 token。 */
export function usePublicApiTokens() {
  return useQuery({
    queryKey: PUBLIC_API_TOKENS_QUERY_KEY,
    queryFn: ({ signal }) => publicApiService.listTokens(signal),
  });
}

/** 创建 token 后只把脱敏 token 元信息写入缓存；plainToken 由调用方短暂展示一次。 */
export function useCreatePublicApiToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => publicApiService.createToken({ name }),
    onSuccess: (response) => {
      queryClient.setQueryData(PUBLIC_API_TOKENS_QUERY_KEY, (current: Awaited<ReturnType<typeof publicApiService.listTokens>> | undefined) => {
        const tokens = current ?? [];
        return [response.token, ...tokens.filter((token) => token.id !== response.token.id)];
      });
    },
  });
}

/** 删除 token 的安全边界在服务端移除 hash 行；前端缓存只负责让管理列表即时收敛。 */
export function useDeletePublicApiToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => publicApiService.deleteToken(id),
    onSuccess: (_, id) => {
      queryClient.setQueryData(PUBLIC_API_TOKENS_QUERY_KEY, (current: Awaited<ReturnType<typeof publicApiService.listTokens>> | undefined) => {
        if (!current) return current;
        return current.filter((token) => token.id !== id);
      });
    },
  });
}
