import type { QueryClient } from "@tanstack/react-query";
import {
  subscriptionFacetsQueryOptions,
  subscriptionsInfiniteQueryOptions,
} from "@/hooks/use-subscriptions";

export async function preload(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.prefetchInfiniteQuery(subscriptionsInfiniteQueryOptions()),
    queryClient.prefetchQuery(subscriptionFacetsQueryOptions()),
  ]);
}
