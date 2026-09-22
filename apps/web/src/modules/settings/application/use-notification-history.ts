/**
 * 通知历史查询 Hook。
 *
 * 架构位置：
 * - 设置 presentation 只负责展示，分页、筛选和 schema 校验都集中在这里。
 * - overview 与 history 是独立后端契约；hook 只在内存中组合成展示 view model。
 *
 * 状态链路：
 * ```
 * overview query -> 独立刷新当前调度状态
 * 状态筛选 -> history queryKey 变化 -> placeholder 清空旧筛选历史
 * fetchNextPage -> 合并 pages.jobs -> presentation 选择详情行
 * ```
 *
 * 注意： notification job result 已在 schema 层建成联合类型；展示层不要再用动态 Record 读取任意字段。
 */
import { useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  type NotificationHistoryResponse as NotificationHistoryPage,
  type NotificationHistoryStatusFilter,
  type NotificationOverviewResponse,
} from "@/lib/api/schemas/notifications";
import { notificationService } from "@/services/notification-service";
import { toSettingsReadState, type SettingsReadState } from "./settings-read-state";

export type {
  NotificationJobResult,
  NotificationHistoryJob,
  NotificationHistoryStatusFilter,
  UpcomingNotificationBatch,
} from "@/lib/api/schemas/notifications";

const HISTORY_PAGE_SIZE = 20;

export function useNotificationHistory() {
  const [status, setStatus] = useState<NotificationHistoryStatusFilter>("all");

  const overviewQuery = useQuery({
    queryKey: ["notification-overview"],
    queryFn: async ({ signal }) => await notificationService.overview(signal),
  });

  const historyQuery = useInfiniteQuery({
    queryKey: ["notification-history", status],
    initialPageParam: 0,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal, pageParam }) => {
      return await notificationService.history(status, HISTORY_PAGE_SIZE, typeof pageParam === "number" ? pageParam : 0, signal);
    },
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined,
  });

  const historyData = useMemo<NotificationHistoryPage | undefined>(() => {
    const pages = historyQuery.data?.pages;
    const first = pages?.[0];
    if (!first) return undefined;

    const latest = pages?.[pages.length - 1] ?? first;
    const jobs = historyQuery.isPlaceholderData ? [] : (pages?.flatMap((page) => page.jobs) ?? []);

    return {
      ...first,
      jobs,
      status,
      limit: jobs.length,
      offset: 0,
      hasMore: historyQuery.isPlaceholderData ? false : latest.hasMore,
    };
  }, [historyQuery.data?.pages, historyQuery.isPlaceholderData, status]);

  const overview = toSettingsReadState(overviewQuery);
  const history = {
    ...toSettingsReadState(historyQuery),
    data: historyData,
    hasData: historyData !== undefined,
    isInitialLoading: (historyQuery.isPending || historyQuery.isPlaceholderData)
      && historyQuery.isFetching
      && historyData === undefined,
  } satisfies SettingsReadState<NotificationHistoryPage>;

  return {
    overview,
    history,
    historyStatus: status,
    setStatus,
    limit: HISTORY_PAGE_SIZE,
    loadMore: () => {
      if (historyQuery.hasNextPage) void historyQuery.fetchNextPage();
    },
  };
}

export type SettingsNotificationHistoryController = ReturnType<typeof useNotificationHistory>;
