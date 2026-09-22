import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";

function shouldRetryClientQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  if (error instanceof Error && error.name === "AbortError") return false;
  if (!(error instanceof ApiError)) return true;
  return error.code === "network"
    || error.code === "timeout"
    || error.status === 408
    || error.status === 429
    || error.status >= 500;
}

/** 浏览器应用只拥有一个 QueryClient；启动预取、路由 intent 与组件订阅必须共享同一缓存图。 */
export const appQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetryClientQuery,
      staleTime: 15_000,
    },
  },
});
