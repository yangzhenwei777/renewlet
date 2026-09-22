export interface SettingsReadState<T> {
  data: T | undefined;
  hasData: boolean;
  error: Error | null;
  isInitialLoading: boolean;
  isRefreshing: boolean;
  retry: () => Promise<void>;
}

interface SettingsReadQuery<T> {
  data: T | undefined;
  error: unknown;
  isFetched: boolean;
  isPending: boolean;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
}

export function toSettingsReadState<T>(query: SettingsReadQuery<T>): SettingsReadState<T> {
  const hasData = query.data !== undefined;
  const isInitialLoading = !query.isFetched && query.isPending && query.isFetching && !hasData;
  return {
    data: query.data,
    hasData,
    error: normalizeSettingsReadError(query.error),
    isInitialLoading,
    // 首次失败后的 refetch 没有缓存可保留，但仍必须进入进行中状态，避免重试按钮重复提交或把失败误报为空数据。
    isRefreshing: query.isFetching && !isInitialLoading,
    retry: async () => {
      await query.refetch();
    },
  };
}

function normalizeSettingsReadError(error: unknown): Error | null {
  if (error instanceof Error) return error;
  return error ? new Error("Settings read failed") : null;
}
