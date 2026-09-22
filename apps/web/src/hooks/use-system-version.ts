import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { systemService } from "@/services/system-service";

export const systemVersionQueryKey = ["system-version"] as const;
export const systemUpdateStatusQueryKey = ["system-update-status"] as const;
const SYSTEM_UPDATE_POLL_MS = 1_000;

/**
 * 读取系统版本状态。
 *
 * `force=true` 会绕过后端缓存；小弹窗打开时使用它，后台 badge 保持普通缓存，
 * 避免每次页面渲染都请求 GitHub Release Atom feed。
 */
export function useSystemVersion(enabled: boolean, force = false) {
  return useQuery({
    queryKey: [...systemVersionQueryKey, force],
    queryFn: ({ signal }) => systemService.version(force, signal),
    enabled,
    retry: false,
    staleTime: 20 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

/** 读取单实例更新任务；POST 尚未返回时也轮询，可恢复响应丢失但后台已启动的任务。 */
export function useSystemUpdateStatus(enabled: boolean, pollWhileStarting = false) {
  const queryClient = useQueryClient();
  const invalidatedTerminalRef = useRef<string | null>(null);
  const query = useQuery({
    queryKey: systemUpdateStatusQueryKey,
    queryFn: ({ signal }) => systemService.updateStatus(signal),
    enabled,
    retry: false,
    refetchInterval: (currentQuery) => {
      const operation = currentQuery.state.data?.operation;
      return pollWhileStarting || operation?.status === "running" ? SYSTEM_UPDATE_POLL_MS : false;
    },
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const operation = query.data?.operation;
    if (!operation || operation.status === "running") {
      invalidatedTerminalRef.current = null;
      return;
    }
    const terminalKey = `${operation.id}:${operation.status}`;
    // 轮询可能多次观察到同一终态；按任务终态去重，避免 invalidate -> refetch -> effect 形成版本请求循环。
    if (invalidatedTerminalRef.current === terminalKey) return;
    invalidatedTerminalRef.current = terminalKey;
    // 只刷新弹窗使用的 force=true 查询；后台 badge 继续共享既有缓存，避免同一终态并发请求两次 Release feed。
    void queryClient.invalidateQueries({ queryKey: [...systemVersionQueryKey, true], exact: true });
  }, [query.data?.operation, queryClient]);

  return query;
}

/** 触发 Docker 页面内更新；成功只表示任务已创建，执行进度统一从 status cache 读取。 */
export function useSystemUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => systemService.update(),
    onSuccess: (response) => {
      queryClient.setQueryData(systemUpdateStatusQueryKey, response);
      void queryClient.invalidateQueries({ queryKey: systemUpdateStatusQueryKey });
    },
    onError: () => {
      // POST 响应可能在代理或网络层丢失；主动补一次状态读取，以服务端任务 ID 恢复真实结果。
      void queryClient.invalidateQueries({ queryKey: systemUpdateStatusQueryKey });
    },
  });
}

/** 单次确认后端 restart pending；Cloudflare/source runtime 会在 service 层返回不支持。 */
export function useSystemRestart() {
  return useMutation({
    mutationFn: () => systemService.restart(),
  });
}
