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
export function useSubscriptionCalendarDialog(subscriptions: readonly SubscriptionCollectionItem[]) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<SubscriptionDialogTarget | null>(null);
  const [open, setOpen] = useState(false);
  const subscriptionId = target?.id ?? null;
  const detailQuery = useSubscriptionDetail(subscriptionId, open);
  const currentDialogSession = useMemo(() => ({
    subscription: detailQuery.data ?? null,
    collectionItem: target?.collectionItem ?? null,
    pending: detailQuery.isPending,
    error: detailQuery.error,
  }), [detailQuery.data, detailQuery.error, detailQuery.isPending, target?.collectionItem]);
  const dialogSession = useDialogSessionSnapshot(open, subscriptionId, currentDialogSession);
  const { scheduleCleanup, cancelCleanup } = useDeferredDialogCleanup(() => setTarget(null));

  const prefetch = useCallback((id: string) => {
    void prefetchSubscriptionDetail(queryClient, id);
  }, [queryClient]);

  const show = useCallback((id: string) => {
    cancelCleanup();
    setTarget(createSubscriptionDialogTarget(subscriptions, id));
    setOpen(true);
  }, [cancelCleanup, subscriptions]);

  const onOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      cancelCleanup();
      return;
    }
    scheduleCleanup();
  }, [cancelCleanup, scheduleCleanup]);

  return {
    open,
    subscription: dialogSession.subscription,
    collectionItem: dialogSession.collectionItem,
    pending: dialogSession.pending,
    error: dialogSession.error,
    prefetch,
    show,
    onOpenChange,
  };
}
