import type { QueryClient } from "@tanstack/react-query";
import type { DateOnly } from "@/lib/time/date-only";
import type { SubscriptionListFilters } from "@/services/subscription-service";

const EMPTY_FILTERS: SubscriptionListFilters = {};

function queryFilters(filters?: SubscriptionListFilters): SubscriptionListFilters {
  return filters ?? EMPTY_FILTERS;
}

export const subscriptionQueryKeys = {
  all: ["subscriptions"] as const,
  collections: ["subscriptions", "collections"] as const,
  collectionBoundary: ["subscriptions", "collection-boundary"] as const,
  pages: ["subscriptions", "collections", "page"] as const,
  indexes: ["subscriptions", "collections", "index"] as const,
  page: (filters?: SubscriptionListFilters) => ["subscriptions", "collections", "page", queryFilters(filters)] as const,
  index: (filters?: SubscriptionListFilters) => ["subscriptions", "collections", "index", queryFilters(filters)] as const,
  analytics: ["subscriptions", "collections", "analytics"] as const,
  calendar: (from: DateOnly, to: DateOnly) => ["subscriptions", "collections", "calendar", from, to] as const,
  facets: ["subscriptions", "collections", "facets"] as const,
  details: ["subscriptions", "details"] as const,
  detail: (id: string) => ["subscriptions", "details", id] as const,
};

export function invalidateSubscriptionCollections(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.collections });
}

export function resetSubscriptionCollections(queryClient: QueryClient) {
  // asOf 只参与 page/index；facets、analytics 和显式日期范围 calendar 不应在本地午夜被连带刷新。
  return Promise.all([
    queryClient.resetQueries({ queryKey: subscriptionQueryKeys.pages }),
    queryClient.resetQueries({ queryKey: subscriptionQueryKeys.indexes }),
  ]);
}

export function syncSubscriptionCollectionBoundary(
  queryClient: QueryClient,
  boundary: string,
  { resetOnInitialize = false }: { resetOnInitialize?: boolean } = {},
) {
  const previousBoundary = queryClient.getQueryData<string>(subscriptionQueryKeys.collectionBoundary);
  if (previousBoundary === boundary) return undefined;

  // boundary 标记跟随 QueryClient 跨路由存活，避免页面在午夜前卸载、午夜后重挂时复用旧 asOf 的分页链。
  queryClient.setQueryData(subscriptionQueryKeys.collectionBoundary, boundary);
  return previousBoundary === undefined && !resetOnInitialize
    ? undefined
    : resetSubscriptionCollections(queryClient);
}

export function removeSubscriptionDetails(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: subscriptionQueryKeys.details });
}

export function clearSubscriptionQueries(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: subscriptionQueryKeys.all });
}
