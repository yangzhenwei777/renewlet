import type { QueryClient } from "@tanstack/react-query";
import { subscriptionFacetsQueryOptions } from "@/hooks/use-subscriptions";

export async function preload(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.prefetchQuery(subscriptionFacetsQueryOptions()),
  ]);
}
