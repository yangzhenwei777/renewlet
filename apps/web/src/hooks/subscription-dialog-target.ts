import type { SubscriptionCollectionItem } from "@/types/subscription";

export interface SubscriptionDialogTarget {
  id: string;
  collectionItem: SubscriptionCollectionItem | null;
}

// 列表预览只保存交互意图发生时已知的结构，不能触发详情请求或猜测详情专属字段。
export function createSubscriptionDialogTarget(
  subscriptions: readonly SubscriptionCollectionItem[],
  id: string,
): SubscriptionDialogTarget {
  return {
    id,
    collectionItem: subscriptions.find((subscription) => subscription.id === id) ?? null,
  };
}
