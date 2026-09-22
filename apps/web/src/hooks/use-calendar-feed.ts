import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { CalendarFeedStatus } from "@/lib/api/schemas/calendar-feed";
import { CALENDAR_FEED_QUERY_ROOT } from "@/hooks/calendar-feed-query-cache";
import {
  calendarFeedService,
  calendarFeedTargetKey,
  type CalendarFeedTarget,
} from "@/services/calendar-feed-service";

const SUBSCRIPTION_CALENDAR_FEED_PAGE_SIZE = 20;

export const calendarFeedQueryKeys = {
  all: CALENDAR_FEED_QUERY_ROOT,
  subscriptionLists: () => [...calendarFeedQueryKeys.all, "subscription-list"] as const,
  target: (target: CalendarFeedTarget) => [
    ...calendarFeedQueryKeys.all,
    "target",
    calendarFeedTargetKey(target),
  ] as const,
};

export function useCalendarFeedStatus(target: CalendarFeedTarget, enabled = true) {
  return useQuery({
    queryKey: calendarFeedQueryKeys.target(target),
    queryFn: ({ signal }) => calendarFeedService.get(target, signal),
    enabled,
  });
}

export function useSubscriptionCalendarFeeds() {
  return useInfiniteQuery({
    queryKey: calendarFeedQueryKeys.subscriptionLists(),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => calendarFeedService.listSubscriptions({
      limit: SUBSCRIPTION_CALENDAR_FEED_PAGE_SIZE,
      offset: pageParam,
    }, signal),
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined,
  });
}

function syncCalendarFeedMutation(
  queryClient: QueryClient,
  target: CalendarFeedTarget,
  calendarFeed: CalendarFeedStatus,
) {
  // 定向缓存立即收敛；只有单订阅变更会影响管理分页，全局 token 变化不能制造无关请求。
  queryClient.setQueryData(calendarFeedQueryKeys.target(target), calendarFeed);
  if (target.scope === "subscription") {
    void queryClient.invalidateQueries({ queryKey: calendarFeedQueryKeys.subscriptionLists() });
  }
}

export function useCreateCalendarFeed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (target: CalendarFeedTarget) => calendarFeedService.create(target),
    onSuccess: (calendarFeed, target) => syncCalendarFeedMutation(queryClient, target, calendarFeed),
  });
}

export function useRotateCalendarFeed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (target: CalendarFeedTarget) => calendarFeedService.rotate(target),
    onSuccess: (calendarFeed, target) => syncCalendarFeedMutation(queryClient, target, calendarFeed),
  });
}

export function useDeleteCalendarFeed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (target: CalendarFeedTarget) => calendarFeedService.delete(target),
    onSuccess: (_, target) => syncCalendarFeedMutation(queryClient, target, { enabled: false }),
  });
}
