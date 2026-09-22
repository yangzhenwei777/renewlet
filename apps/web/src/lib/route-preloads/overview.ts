import type { QueryClient } from "@tanstack/react-query";
import {
  subscriptionAnalyticsQueryOptions,
  subscriptionFacetsQueryOptions,
} from "@/hooks/use-subscriptions";

export async function preload(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.prefetchQuery(subscriptionAnalyticsQueryOptions()),
    queryClient.prefetchQuery(subscriptionFacetsQueryOptions()),
  ]);
}
