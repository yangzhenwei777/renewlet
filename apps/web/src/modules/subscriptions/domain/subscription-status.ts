/**
 * 订阅有效状态计算。
 *
 * 架构位置：
 * - 原始 status 仍来自数据库。
 * - UI、筛选和统计统一消费这里的“有效状态”，避免同一条过期订阅在不同页面语义不一致。
 */
import { compareDateOnly, type DateOnly } from "@/lib/time/date-only";
import { isOneTimeBuyout } from "@/lib/subscription-billing";
import type { BillingCycle, SubscriptionCollectionItem, SubscriptionStatus } from "@/types/subscription";

/** 按用户本地今天计算订阅的有效状态。 */
export function getEffectiveSubscriptionStatus(
  subscription: Pick<SubscriptionCollectionItem, "status" | "nextBillingDate"> & {
    billingCycle?: BillingCycle;
    oneTimeTermCount?: number | undefined;
    oneTimeTermUnit?: SubscriptionCollectionItem["oneTimeTermUnit"];
  },
  today: DateOnly | string,
): SubscriptionStatus {
  if (subscription.status === "expired") return "expired";
  // one-time 买断记录没有权益到期边界；固定服务期则继续使用 nextBillingDate 进入 expired 兼容状态。
  if (subscription.billingCycle === "one-time" && isOneTimeBuyout({
    billingCycle: subscription.billingCycle,
    oneTimeTermCount: subscription.oneTimeTermCount,
    oneTimeTermUnit: subscription.oneTimeTermUnit,
  })) {
    return subscription.status;
  }

  // 兼容旧数据：升级时不静默改写数据库，只在读取侧把已过扣费日的 active/trial 呈现为 expired。
  // paused/cancelled 代表用户显式停用意图，日期过期也不覆盖，避免把“用户主动停用”误判成“系统自动过期”。
  if (
    (subscription.status === "active" || subscription.status === "trial") &&
    compareDateOnly(subscription.nextBillingDate, today) < 0
  ) {
    return "expired";
  }

  return subscription.status;
}

export function isEffectivelyActiveSubscription(
  subscription: Parameters<typeof getEffectiveSubscriptionStatus>[0],
  today: DateOnly | string,
): boolean {
  const status = getEffectiveSubscriptionStatus(subscription, today);
  return status === "active" || status === "trial";
}

export function isEffectivelyInactiveSubscription(
  subscription: Parameters<typeof getEffectiveSubscriptionStatus>[0],
  today: DateOnly | string,
): boolean {
  const status = getEffectiveSubscriptionStatus(subscription, today);
  return status === "expired" || status === "paused" || status === "cancelled";
}
