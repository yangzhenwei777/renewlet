import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { prefetchSubscriptionDetail, useSubscriptionDetail } from "@/hooks/use-subscriptions";
import { useDeferredDialogCleanup } from "@/hooks/use-deferred-dialog-cleanup";
import { useDialogSessionSnapshot } from "@/hooks/use-dialog-session-snapshot";
import {
  createSubscriptionDialogTarget,
  type SubscriptionDialogTarget,
} from "@/hooks/subscription-dialog-target";
import type { SubscriptionCollectionItem } from "@/types/subscription";

export function useSubscriptionDetailDialog(subscriptions: readonly SubscriptionCollectionItem[]) {
  const queryClient = useQueryClient();
  const [detailTarget, setDetailTarget] = useState<SubscriptionDialogTarget | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const detailSubscriptionId = detailTarget?.id ?? null;
  const detailQuery = useSubscriptionDetail(detailSubscriptionId, detailDialogOpen);
  const currentDetailDialogSession = useMemo(() => ({
    subscription: detailQuery.data ?? null,
    collectionItem: detailTarget?.collectionItem ?? null,
    pending: detailQuery.isPending,
    error: detailQuery.error,
  }), [detailQuery.data, detailQuery.error, detailQuery.isPending, detailTarget?.collectionItem]);
  const detailDialogSession = useDialogSessionSnapshot(
    detailDialogOpen,
    detailSubscriptionId,
    currentDetailDialogSession,
  );
  const { scheduleCleanup: scheduleDetailCleanup, cancelCleanup: cancelDetailCleanup } =
    useDeferredDialogCleanup(() => {
      // 详情关闭动画期间保留 id 与 cache 绑定，避免 Dialog/Drawer fade-out 时标题和内容闪空。
      setDetailTarget(null);
    });

  const handlePrefetchDetails = useCallback((id: string) => {
    void prefetchSubscriptionDetail(queryClient, id);
  }, [queryClient]);

  const handleViewDetails = useCallback((id: string) => {
    cancelDetailCleanup();
    setDetailTarget(createSubscriptionDialogTarget(subscriptions, id));
    setDetailDialogOpen(true);
  }, [cancelDetailCleanup, subscriptions]);

  const handleDetailDialogOpenChange = useCallback((nextOpen: boolean) => {
    setDetailDialogOpen(nextOpen);
    if (nextOpen) {
      cancelDetailCleanup();
      return;
    }
    scheduleDetailCleanup();
  }, [cancelDetailCleanup, scheduleDetailCleanup]);

  return {
    detailDialogOpen,
    selectedDetailSubscription: detailDialogSession.subscription,
    selectedDetailCollectionItem: detailDialogSession.collectionItem,
    detailPending: detailDialogSession.pending,
    detailError: detailDialogSession.error,
    handlePrefetchDetails,
    handleViewDetails,
    handleDetailDialogOpenChange,
  };
}
