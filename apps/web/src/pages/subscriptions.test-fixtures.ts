import { appSettingsSecretStatus } from "@renewlet/shared/schemas/settings";
import { todayDateOnlyInTimeZone } from "@/lib/time/date-only";
import { filterSubscriptionsByListFilters } from "@/modules/subscriptions/domain/subscription-filters";
import type { SubscriptionListFilters } from "@/services/subscription-service";
import type { SettingsReadModel } from "@/services/settings-service";
import { DEFAULT_SETTINGS, type Subscription } from "@/types/subscription";

const settings = {
  ...DEFAULT_SETTINGS,
  timezone: "Asia/Shanghai",
  defaultCurrency: "CNY",
  notificationReminderDays: 5,
  subscriptionPriceReferenceEnabled: true,
  subscriptionPriceReferenceCurrency: "USD",
};

export const DEFAULT_SUBSCRIPTIONS_PAGE_SETTINGS: SettingsReadModel = {
  settings,
  secretStatus: appSettingsSecretStatus(settings),
};

interface SubscriptionIndexQueryFixture {
  data: { subscriptions: Subscription[]; total: number };
  isPending: boolean;
  error: unknown | null;
  refetch: () => Promise<void>;
}

/** 页面测试以此模拟 index endpoint；基础与高级筛选共用 CSV 导出的同一查询语义。 */
export function subscriptionIndexQueryFixture(
  subscriptions: readonly Subscription[],
  filters?: SubscriptionListFilters,
): SubscriptionIndexQueryFixture {
  const today = todayDateOnlyInTimeZone(new Date(), settings.timezone);
  const filtered = filterSubscriptionsByListFilters(subscriptions, filters, { today });

  return {
    data: { subscriptions: filtered, total: filtered.length },
    isPending: false,
    error: null,
    refetch: async () => undefined,
  };
}

export function subscriptionFacetsQueryFixture(subscriptions: readonly Subscription[]) {
  const categoryCounts = subscriptions.reduce<Record<string, number>>((counts, subscription) => {
    counts[subscription.category] = (counts[subscription.category] ?? 0) + 1;
    return counts;
  }, {});
  const tags = Array.from(new Set(subscriptions.flatMap((subscription) => subscription.tags))).sort();
  const hiddenCount = subscriptions.filter((subscription) => subscription.publicHidden).length;

  return {
    data: {
      total: subscriptions.length,
      categoryCounts,
      tags,
      visibleCount: subscriptions.length - hiddenCount,
      hiddenCount,
    },
    isPending: false,
  };
}
