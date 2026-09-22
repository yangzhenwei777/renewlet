/**
 * 认证状态同步（客户端）。
 *
 * 背景：
 * - 登录/退出会影响当前用户的数据：订阅列表、设置、自定义配置
 * - React Query 需要在认证状态变化时刷新缓存，避免“旧用户数据残留”
 *
 * 额外说明（路由保护）：
 * - ProtectedRoute 负责拦住私有页面挂载；这里只处理登录页回跳和会话变化后的缓存刷新。
 *
 * 状态链路：
 * ```
 * 产品 session 恢复中 -> 不做跳转
 * 会话已解析 -> 已登录访问 /login -> sanitize(next)
 * 非密 session key 变化 -> invalidate 用户相关 query
 * ```
 *
 * 注意： 必须等待 `isPending=false` 再判断未登录，否则刷新首帧可能误判。
 */

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "@/lib/router";
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { sanitizeNextPath } from "@/lib/redirect";
import { SETTINGS_QUERY_KEY } from "@/hooks/settings-query-key";
import { clearCalendarFeedQueries } from "@/hooks/calendar-feed-query-cache";
import { clearSubscriptionQueries } from "@/hooks/subscription-query-cache";

/** 监听 Auth 状态变化，并主动刷新相关 Query 缓存。 */
export function AuthSync() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: sessionData, isPending } = authClient.useSession();
  const previousSessionKeyRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    // 等待首轮 session 加载完成；pending 阶段不能把空 data 当成未登录。
    if (isPending) return;

    const hasSession = Boolean(sessionData?.session);
    if (hasSession && pathname === "/login") {
      router.replace(sanitizeNextPath(searchParams?.get("next"), "/"));
    }
  }, [isPending, pathname, router, searchParams, sessionData?.session]);

  useEffect(() => {
    // HttpOnly session token 不出站；用 user+expiresAt 这类非密快照识别登录、退出和续签后的缓存边界。
    if (isPending) return;
    const sessionKey = sessionData
      ? `${sessionData.user.id}:${sessionData.session.expiresAt}`
      : null;
    if (previousSessionKeyRef.current === undefined) {
      previousSessionKeyRef.current = sessionKey;
      return;
    }
    if (previousSessionKeyRef.current === sessionKey) return;
    previousSessionKeyRef.current = sessionKey;

    // 会话身份变化必须删除而非仅失效，避免新用户在 refetch 前看到旧用户详情或 bearer URL。
    clearSubscriptionQueries(queryClient);
    clearCalendarFeedQueries(queryClient);
    queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: ["custom-config"] });
  }, [isPending, queryClient, sessionData]);

  return null;
}
