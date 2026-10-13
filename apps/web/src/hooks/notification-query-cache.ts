import type { QueryClient } from "@tanstack/react-query";

export const notificationQueryKeys = {
  overview: ["notification-overview"] as const,
};

// 写入成功只让概览失效；活动查询后台刷新，未挂载的设置页等返回时再读取，避免全局轮询。
export function invalidateNotificationOverview(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: notificationQueryKeys.overview });
}
