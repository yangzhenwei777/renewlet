import type { QueryClient } from "@tanstack/react-query";

export const CALENDAR_FEED_QUERY_ROOT = ["calendar-feeds"] as const;

/** Feed URL 是 bearer secret；身份变化时必须删除整棵缓存，不能让新用户在 refetch 前看到旧 URL。 */
export function clearCalendarFeedQueries(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: CALENDAR_FEED_QUERY_ROOT });
}
