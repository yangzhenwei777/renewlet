import { lazy, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { StatisticsChartsProps } from "@/components/statistics-charts";

const LazyStatisticsCharts = lazy(() =>
  import("@/components/statistics-charts").then((module) => ({ default: module.StatisticsCharts })),
);

function StatisticsChartsLoading() {
  return (
    <div className="grid gap-8" aria-hidden="true" data-testid="statistics-charts-loading">
      <Skeleton className="h-96 w-full rounded-xl" />
      <div className="grid gap-6 md:grid-cols-2">
        <Skeleton className="h-80 w-full rounded-xl" />
        <Skeleton className="h-80 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl md:col-span-2" />
      </div>
    </div>
  );
}

/** 图表在统计数据就绪后独立加载，避免 Recharts 阻塞页面概要与交互控制的首次渲染。 */
export function DeferredStatisticsCharts(props: StatisticsChartsProps) {
  return (
    <Suspense fallback={<StatisticsChartsLoading />}>
      <LazyStatisticsCharts {...props} />
    </Suspense>
  );
}
