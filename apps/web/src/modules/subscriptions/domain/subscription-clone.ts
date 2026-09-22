import type { Subscription, SubscriptionDraft, SubscriptionFormSubmission } from "@/types/subscription";

export function cloneSubscriptionExtra(extra: Subscription["extra"]): Record<string, unknown> | undefined {
  const nextExtra = { ...extra };
  // extra.import 是导入幂等键；克隆订阅若继续携带它，后续导入会把原记录和副本误判为同源。
  delete nextExtra["import"];
  return Object.keys(nextExtra).length === 0 ? undefined : nextExtra;
}

export function buildClonedSubscriptionDraft(
  source: Subscription,
  submission: SubscriptionFormSubmission,
): SubscriptionDraft {
  const extra = cloneSubscriptionExtra(source.extra);
  const base = {
    ...submission,
    pinned: source.pinned,
    ...(extra ? { extra } : {}),
  };
  return base;
}
