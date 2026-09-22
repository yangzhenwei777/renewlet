import { lazy, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { SubscriptionAdvancedDateRangeFieldsProps } from "@/components/subscription-advanced-date-range-fields";

const LazySubscriptionAdvancedDateRangeFields = lazy(() =>
  import("@/components/subscription-advanced-date-range-fields").then((module) => ({
    default: module.SubscriptionAdvancedDateRangeFields,
  })),
);

function SubscriptionAdvancedDateRangeFieldsLoading() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-hidden="true">
      <div className="space-y-1.5">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="space-y-1.5">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}

/** 日历只属于已打开的高级筛选面板，筛选草稿仍由外层状态机持有。 */
export function DeferredSubscriptionAdvancedDateRangeFields(props: SubscriptionAdvancedDateRangeFieldsProps) {
  return (
    <Suspense fallback={<SubscriptionAdvancedDateRangeFieldsLoading />}>
      <LazySubscriptionAdvancedDateRangeFields {...props} />
    </Suspense>
  );
}
