import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  subscriptionQueryKeys,
  syncSubscriptionCollectionBoundary,
} from "./subscription-query-cache";

describe("subscription collection boundary cache", () => {
  it("keeps the boundary across remounts and resets only page/index when it changes", async () => {
    const queryClient = new QueryClient();
    const resetQueries = vi.spyOn(queryClient, "resetQueries");

    expect(syncSubscriptionCollectionBoundary(queryClient, "UTC:2026-08-31")).toBeUndefined();
    expect(queryClient.getQueryData(subscriptionQueryKeys.collectionBoundary)).toBe("UTC:2026-08-31");
    expect(resetQueries).not.toHaveBeenCalled();

    await syncSubscriptionCollectionBoundary(queryClient, "UTC:2026-09-01");
    expect(resetQueries).toHaveBeenNthCalledWith(1, { queryKey: subscriptionQueryKeys.pages });
    expect(resetQueries).toHaveBeenNthCalledWith(2, { queryKey: subscriptionQueryKeys.indexes });
    expect(resetQueries).not.toHaveBeenCalledWith({ queryKey: subscriptionQueryKeys.collections });
    expect(queryClient.getQueryData(subscriptionQueryKeys.collectionBoundary)).toBe("UTC:2026-09-01");
  });

  it("can reset existing collection chains when a timezone mutation initializes the boundary", async () => {
    const queryClient = new QueryClient();
    const resetQueries = vi.spyOn(queryClient, "resetQueries");

    await syncSubscriptionCollectionBoundary(queryClient, "Asia/Shanghai:2026-09-01", { resetOnInitialize: true });

    expect(resetQueries).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(subscriptionQueryKeys.collectionBoundary)).toBe("Asia/Shanghai:2026-09-01");
  });
});
