import { lazy, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { SpendingChartProps } from "@/components/spending-chart";

const LazySpendingChart = lazy(() =>
  import("@/components/spending-chart").then((module) => ({ default: module.SpendingChart })),
);

/** 固定图表区域高度，避免 Recharts 下载与初始化期间改变 Dashboard 侧栏布局。 */
export function DeferredSpendingChart(props: SpendingChartProps) {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full rounded-lg" aria-hidden="true" />}>
      <LazySpendingChart {...props} />
    </Suspense>
  );
}
