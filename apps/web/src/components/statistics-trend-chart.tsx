/**
 * 统计页费用走势柱状图。
 *
 * 架构位置：只渲染 statistics-model 生成的趋势 view model，不在组件内推导账单口径。
 */
import { useEffect, useId, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { RechartsFrame } from "@/components/recharts-frame";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TruncatedTooltipText } from "@/components/ui/truncated-tooltip-text";
import { useI18n } from "@/i18n/I18nProvider";
import type { StatisticsTrendDatum, StatisticsTrendItem } from "@/modules/subscriptions/domain/statistics-model";

const STATISTICS_TREND_CHART_HEIGHT = 280;

type TrendMode = "cashflow" | "amortized";
type TrendItemBadgeCellSize = "tooltip" | "detail";

const TREND_ITEM_BADGE_CLASS_NAME = [
  "inline-flex w-[6em] max-w-full shrink-0 items-center justify-center truncate rounded-full",
  "border border-border/60 bg-secondary/45 px-2 font-medium leading-none",
  "tabular-nums text-muted-foreground",
].join(" ");
const trendItemBadgeSizeClassNames = {
  tooltip: "h-5 text-[11px]",
  detail: "h-6 text-xs",
} satisfies Record<TrendItemBadgeCellSize, string>;

type TrendTooltipPayload = {
  value?: unknown;
  payload?: unknown;
};

type TrendTooltipProps = {
  active: boolean;
  payload: readonly TrendTooltipPayload[];
  mode: TrendMode;
};

type TooltipTrendItem = Omit<StatisticsTrendItem, "firstDate" | "lastDate"> & {
  firstDate: string | null;
  lastDate: string | null;
};

interface StatisticsTrendChartProps {
  data: readonly StatisticsTrendDatum[];
  defaultCurrency: string;
  onViewSubscriptionDetails: (subscriptionId: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrendTooltipProps(value: unknown, mode: TrendMode): TrendTooltipProps {
  if (!isRecord(value)) return { active: false, payload: [], mode };
  const payload = Array.isArray(value["payload"])
    ? value["payload"].filter(isRecord)
    : [];
  return {
    active: value["active"] === true,
    payload,
    mode,
  };
}

function trendModeValue(value: string): TrendMode {
  return value === "amortized" ? "amortized" : "cashflow";
}

function isTooltipTrendItem(value: unknown): value is TooltipTrendItem {
  if (!isRecord(value)) return false;
  const firstDate = value["firstDate"];
  const lastDate = value["lastDate"];
  return (
    typeof value["subscriptionId"] === "string" &&
    typeof value["name"] === "string" &&
    typeof value["amount"] === "number" &&
    typeof value["occurrenceCount"] === "number" &&
    (firstDate === null || typeof firstDate === "string") &&
    (lastDate === null || typeof lastDate === "string")
  );
}

function trendItemsForMode(source: Record<string, unknown> | null, mode: TrendMode): readonly TooltipTrendItem[] {
  const rawItems = source?.[mode === "cashflow" ? "cashflowItems" : "amortizedItems"];
  return Array.isArray(rawItems) ? rawItems.filter(isTooltipTrendItem) : [];
}

function trendDatumItemsForMode(datum: StatisticsTrendDatum | null | undefined, mode: TrendMode): readonly StatisticsTrendItem[] {
  if (!datum) return [];
  return mode === "cashflow" ? datum.cashflowItems : datum.amortizedItems;
}

function trendDatumValueForMode(datum: StatisticsTrendDatum | null | undefined, mode: TrendMode): number {
  if (!datum) return 0;
  return mode === "cashflow" ? datum.cashflow : datum.amortized;
}

function resolveTrendDetailMonthKey(
  data: readonly StatisticsTrendDatum[],
  mode: TrendMode,
  currentMonthKey: string,
): string {
  const currentDatum = data.find((item) => item.monthKey === currentMonthKey);
  if (currentDatum && trendDatumItemsForMode(currentDatum, mode).length > 0) {
    return currentDatum.monthKey;
  }
  const firstWithItems = data.find((item) => trendDatumItemsForMode(item, mode).length > 0);
  return firstWithItems?.monthKey ?? currentDatum?.monthKey ?? data[0]?.monthKey ?? "";
}

function fallbackTrendDetailMonthKey(
  data: readonly StatisticsTrendDatum[],
  mode: TrendMode,
  currentMonthKey: string,
): string {
  const currentDatum = data.find((item) => item.monthKey === currentMonthKey);
  if (currentDatum) return currentDatum.monthKey;
  const firstWithItems = data.find((item) => trendDatumItemsForMode(item, mode).length > 0);
  return firstWithItems?.monthKey ?? data[0]?.monthKey ?? "";
}

function TrendItemBadgeCell({
  className = "",
  label,
  size,
}: {
  className?: string;
  label: string;
  size: TrendItemBadgeCellSize;
}) {
  return (
    <span className={`min-w-0 justify-self-start ${className}`}>
      <span className={`${TREND_ITEM_BADGE_CLASS_NAME} ${trendItemBadgeSizeClassNames[size]}`}>
        {label}
      </span>
    </span>
  );
}

export function StatisticsTrendChart({ data, defaultCurrency, onViewSubscriptionDetails }: StatisticsTrendChartProps) {
  const { t, formatCurrency, formatDateOnly, formatNumber } = useI18n();
  const [mode, setMode] = useState<TrendMode>("cashflow");
  const [selectedMonthKey, setSelectedMonthKey] = useState("");
  const detailsHeadingId = useId();
  const chartTitle = mode === "cashflow" ? t("statistics.trendCashflow") : t("statistics.trendAmortized");
  const chartHint = mode === "cashflow" ? t("statistics.trendCashflowHint") : t("statistics.trendAmortizedHint");
  const hasTrendValue = data.some((item) => item.cashflow > 0 || item.amortized > 0);
  const tooltipItemLimit = 5;

  useEffect(() => {
    // 切换趋势口径后优先落到有构成的月份，避免图表有柱子而常驻明细停在空月份。
    setSelectedMonthKey((currentMonthKey) => resolveTrendDetailMonthKey(data, mode, currentMonthKey));
  }, [data, mode]);

  const formatTrendItemMeta = (item: TooltipTrendItem | StatisticsTrendItem): string => {
    if (item.firstDate && item.lastDate && item.firstDate !== item.lastDate) {
      return t("statistics.trendItemDateRange", {
        start: formatDateOnly(item.firstDate, "monthDay"),
        end: formatDateOnly(item.lastDate, "monthDay"),
        count: item.occurrenceCount,
      });
    }
    if (item.firstDate) {
      return item.occurrenceCount > 1
        ? t("statistics.trendItemSingleDateCount", {
            date: formatDateOnly(item.firstDate, "monthDay"),
            count: item.occurrenceCount,
          })
        : t("statistics.trendItemSingleDate", { date: formatDateOnly(item.firstDate, "monthDay") });
    }
    return t("statistics.trendItemMonthlyShare");
  };

  const formatTrendItemBadge = (item: TooltipTrendItem | StatisticsTrendItem, itemMode: TrendMode): string => {
    if (itemMode === "amortized") return t("statistics.trendDetailsMonthlyBadge");
    return formatTrendItemMeta(item);
  };

  const trendItemShareRatio = (item: StatisticsTrendItem, total: number): number => {
    if (total <= 0) return 0;
    return Math.min(Math.max(item.amount / total, 0), 1);
  };

  const formatTrendItemShare = (item: StatisticsTrendItem, total: number): string => (
    formatNumber(trendItemShareRatio(item, total), {
      style: "percent",
      maximumFractionDigits: 0,
    })
  );

  const formatTrendItemsSummary = (items: readonly (TooltipTrendItem | StatisticsTrendItem)[]): string => (
    items.length > 0
      ? items.map((item) => t("statistics.trendAccessibleItemDetail", {
          name: item.name,
          amount: formatCurrency(item.amount, defaultCurrency),
          meta: formatTrendItemMeta(item),
        })).join(t("statistics.trendAccessibleItemSeparator"))
      : t("statistics.trendNoItems")
  );

  const CustomTooltip = ({ active, payload, mode: tooltipMode }: TrendTooltipProps) => {
    const first = payload[0];
    const source = first && isRecord(first.payload) ? first.payload : null;
    const monthLabel = typeof source?.["label"] === "string" ? source["label"] : "";
    const rawValue = first?.value;
    const value = typeof rawValue === "number" ? rawValue : 0;
    const items = trendItemsForMode(source, tooltipMode);
    const visibleItems = items.slice(0, tooltipItemLimit);
    const hiddenCount = Math.max(items.length - visibleItems.length, 0);

    if (!active || !first) return null;

    return (
      <div className="max-w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover px-3 py-2 shadow-lg">
        <div className="grid gap-0.5">
          <p className="text-sm font-medium text-foreground">{monthLabel}</p>
          <p className="text-xs text-muted-foreground">
            {tooltipMode === "cashflow" ? t("statistics.trendCashflow") : t("statistics.trendAmortized")}
          </p>
          <p className="text-sm font-semibold text-foreground">{formatCurrency(value, defaultCurrency)}</p>
        </div>

        {visibleItems.length > 0 ? (
          <div className="mt-2 grid min-w-0 grid-cols-[max-content_minmax(0,1fr)_auto] gap-x-2 overflow-hidden rounded-md border border-border/60 bg-background/40">
            {visibleItems.map((item) => (
              <div
                key={item.subscriptionId}
                className="col-span-3 grid min-w-0 grid-cols-subgrid items-center border-b border-border/60 px-2.5 py-2 text-xs last:border-b-0"
              >
                <TrendItemBadgeCell label={formatTrendItemBadge(item, tooltipMode)} size="tooltip" />
                <div className="min-w-0 leading-tight">
                  <p className="truncate font-medium text-foreground">{item.name}</p>
                </div>
                <p className="shrink-0 whitespace-nowrap text-right font-semibold tabular-nums text-foreground">
                  {formatCurrency(item.amount, defaultCurrency)}
                </p>
              </div>
            ))}
            {hiddenCount > 0 ? (
              <p className="col-span-3 border-t border-border/60 px-2.5 py-2 text-xs text-muted-foreground">
                {t("statistics.trendMoreItems", { count: hiddenCount })}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 border-t border-border/70 pt-2 text-xs text-muted-foreground">{t("statistics.trendNoItems")}</p>
        )}
      </div>
    );
  };

  const renderChartContent = (contentMode: TrendMode) => (
    hasTrendValue ? (
      <div className="grid min-w-0 gap-3">
        <RechartsFrame height={STATISTICS_TREND_CHART_HEIGHT} testId="statistics-trend-chart-frame">
          <BarChart
            accessibilityLayer
            data={data}
            margin={{ top: 8, right: 8, bottom: 4, left: 0 }}
            tabIndex={0}
            title={chartTitle}
          >
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              axisLine={false}
              tickLine={false}
              minTickGap={12}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
              tickFormatter={(value) => formatCurrency(Number(value), defaultCurrency)}
              width={72}
              domain={[0, "dataMax"]}
            />
            <RechartsTooltip
              content={(props: unknown) => <CustomTooltip {...readTrendTooltipProps(props, contentMode)} />}
              cursor={false}
              isAnimationActive={false}
              offset={12}
              allowEscapeViewBox={{ x: true, y: true }}
              wrapperStyle={{ pointerEvents: "none" }}
            />
            <Bar
              dataKey={contentMode}
              fill="hsl(var(--chart-1))"
              radius={[4, 4, 0, 0]}
              maxBarSize={42}
              isAnimationActive={false}
              activeBar={{
                fill: "hsl(var(--chart-1))",
                fillOpacity: 0.88,
                stroke: "hsl(var(--chart-1))",
                strokeOpacity: 0.5,
                strokeWidth: 1,
              }}
            />
          </BarChart>
        </RechartsFrame>
        <div className="sr-only" role="list" aria-label={t("statistics.trendTableLabel")}>
          {data.map((item) => (
            <span key={item.monthKey} role="listitem">
              {t("statistics.trendAccessibleItem", {
                month: item.label,
                cashflow: formatCurrency(item.cashflow, defaultCurrency),
                amortized: formatCurrency(item.amortized, defaultCurrency),
                cashflowItems: formatTrendItemsSummary(item.cashflowItems),
                amortizedItems: formatTrendItemsSummary(item.amortizedItems),
              })}
            </span>
          ))}
        </div>
        {(() => {
          const detailMonthKey = fallbackTrendDetailMonthKey(data, contentMode, selectedMonthKey);
          const selectedDatum = data.find((item) => item.monthKey === detailMonthKey) ?? null;
          const detailItems = trendDatumItemsForMode(selectedDatum, contentMode);
          const detailValue = trendDatumValueForMode(selectedDatum, contentMode);
          const detailModeLabel = contentMode === "cashflow" ? t("statistics.trendCashflow") : t("statistics.trendAmortized");
          const selectedMonthLabel = selectedDatum?.label ?? "";
          const detailHeadingId = `${detailsHeadingId}-${contentMode}`;
          const detailTotalLabelId = `${detailHeadingId}-total`;

          return (
            <div className="min-w-0 border-t border-border/70 pt-4">
              <div className="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-background/40">
                <div className="grid min-w-0 gap-3 border-b border-border/60 bg-secondary/15 p-3 sm:p-4">
                  <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                    <h3 id={detailHeadingId} className="truncate text-sm font-semibold leading-none text-foreground">
                      {t("statistics.trendDetailsTitle", { month: selectedMonthLabel })}
                    </h3>
                    <p
                      id={detailTotalLabelId}
                      className="truncate text-xl font-semibold leading-none tracking-normal tabular-nums text-foreground sm:text-right sm:text-2xl"
                    >
                      {formatCurrency(detailValue, defaultCurrency)}
                    </p>
                  </div>
                  <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="rounded-full border border-border/70 bg-background/50 px-2 py-0.5 font-medium text-secondary-foreground">
                        {detailModeLabel}
                      </span>
                      <span className="rounded-full border border-border/60 bg-background/30 px-2 py-0.5">
                        {t("statistics.trendDetailsCount", { count: detailItems.length })}
                      </span>
                    </div>
                    <div className="min-w-0 sm:w-36">
                      <Select value={detailMonthKey} onValueChange={setSelectedMonthKey}>
                        <SelectTrigger
                          aria-label={t("statistics.trendDetailsMonthLabel")}
                          className="h-8 w-full min-w-0 border-border bg-background/70 px-2.5 text-xs shadow-none"
                          tooltipContent={selectedMonthLabel}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {data.map((item) => (
                            <SelectItem key={item.monthKey} value={item.monthKey}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>

                {detailItems.length > 0 ? (
                  <div
                    className="grid max-h-72 min-w-0 overflow-y-auto"
                    role="list"
                    aria-labelledby={detailHeadingId}
                  >
                    {detailItems.map((item) => {
                      const share = formatTrendItemShare(item, detailValue);
                      const shareRatio = trendItemShareRatio(item, detailValue);
                      const shareWidth = shareRatio > 0 ? Math.max(shareRatio * 100, 3) : 0;

                      return (
                        <div
                          key={item.subscriptionId}
                          className="border-b border-border/60 last:border-b-0"
                          role="listitem"
                        >
                          <button
                            type="button"
                            className="grid w-full min-w-0 cursor-pointer grid-cols-[max-content_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2.5 text-left transition-colors @max-sm/statistics-trend:grid-cols-[minmax(0,1fr)_auto] @max-sm/statistics-trend:gap-y-1 hover:bg-secondary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                            aria-label={t("subscription.viewDetailsLabel", { name: item.name })}
                            onClick={() => onViewSubscriptionDetails(item.subscriptionId)}
                          >
                            <TrendItemBadgeCell
                              label={formatTrendItemBadge(item, contentMode)}
                              size="detail"
                              className="@max-sm/statistics-trend:col-span-2"
                            />
                            <span className="min-w-0 self-stretch">
                              <TruncatedTooltipText
                                as="span"
                                text={item.name}
                                align="start"
                                className="text-sm font-medium leading-5 text-foreground"
                              />
                              <span className="mt-1 block h-1 overflow-hidden rounded-full bg-secondary">
                                <span
                                  className="block h-full rounded-full bg-primary/60"
                                  style={{ width: `${shareWidth}%` }}
                                  aria-hidden="true"
                                />
                              </span>
                              <span className="sr-only">
                                {t("statistics.trendDetailsShareLabel", { percent: share })}
                              </span>
                            </span>
                            <span className="min-w-0 shrink-0 text-right">
                              <span className="block shrink-0 whitespace-nowrap text-sm font-semibold tabular-nums text-foreground">
                                {formatCurrency(item.amount, defaultCurrency)}
                              </span>
                              <span className="block whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">{share}</span>
                            </span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="px-3 py-4 text-sm text-muted-foreground">
                    {t("statistics.trendDetailsEmpty")}
                  </p>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    ) : (
      <div
        className="flex min-w-0 items-center justify-center text-muted-foreground"
        style={{ height: STATISTICS_TREND_CHART_HEIGHT }}
      >
        {t("statistics.trendEmpty")}
      </div>
    )
  );

  return (
    <section className="mb-8">
      <Tabs value={mode} onValueChange={(value) => setMode(trendModeValue(value))} className="@container/statistics-trend min-w-0 rounded-xl border border-border bg-card p-6 shadow-card">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-foreground">{t("statistics.trendTitle")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{chartHint}</p>
          </div>
          <TabsList className="grid h-9 w-full grid-cols-2 rounded-md border border-border bg-background p-0.5 sm:w-auto">
            <TabsTrigger value="cashflow" className="h-8 rounded-[5px] px-2.5 text-xs shadow-none data-[state=active]:bg-secondary data-[state=active]:shadow-none sm:px-3">
              {t("statistics.trendCashflow")}
            </TabsTrigger>
            <TabsTrigger value="amortized" className="h-8 rounded-[5px] px-2.5 text-xs shadow-none data-[state=active]:bg-secondary data-[state=active]:shadow-none sm:px-3">
              {t("statistics.trendAmortized")}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="cashflow" className="mt-0">{renderChartContent("cashflow")}</TabsContent>
        <TabsContent value="amortized" className="mt-0">{renderChartContent("amortized")}</TabsContent>
      </Tabs>
    </section>
  );
}
