import { Cell, Pie, PieChart, Tooltip as RechartsTooltip } from "recharts";
import { RechartsFrame } from "@/components/recharts-frame";
import { StatisticsTrendChart } from "@/components/statistics-trend-chart";
import { useI18n } from "@/i18n/I18nProvider";
import type { StatisticsTrendDatum } from "@/modules/subscriptions/domain/statistics-model";

const STATISTICS_DONUT_CHART_HEIGHT = 220;

type ChartValueKind = "currency" | "number";

type ChartTooltipPayload = {
  value?: unknown;
  name?: unknown;
};

type ChartTooltipProps = {
  active: boolean;
  payload: readonly ChartTooltipPayload[];
  valueKind: ChartValueKind;
};

export type StatisticsChartDatum = {
  name: string;
  value: number;
  color: string;
};

export interface StatisticsChartsProps {
  trendData: readonly StatisticsTrendDatum[];
  categoryData: readonly StatisticsChartDatum[];
  paymentData: readonly StatisticsChartDatum[];
  budgetChartData: readonly StatisticsChartDatum[];
  defaultCurrency: string;
  monthlyBudget: string;
  monthlyBudgetAmount: number;
  totalMonthly: number;
  budgetRemaining: number;
  onViewSubscriptionDetails: (subscriptionId: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readChartTooltipProps(value: unknown, valueKind: ChartValueKind): ChartTooltipProps {
  if (!isRecord(value)) return { active: false, payload: [], valueKind };
  const payload = Array.isArray(value["payload"])
    ? value["payload"].filter(isRecord)
    : [];
  return {
    active: value["active"] === true,
    payload,
    valueKind,
  };
}

export function StatisticsCharts({
  trendData,
  categoryData,
  paymentData,
  budgetChartData,
  defaultCurrency,
  monthlyBudget,
  monthlyBudgetAmount,
  totalMonthly,
  budgetRemaining,
  onViewSubscriptionDetails,
}: StatisticsChartsProps) {
  const { t, formatCurrency, formatNumber } = useI18n();

  const CustomTooltip = ({ active, payload, valueKind }: ChartTooltipProps) => {
    const first = payload[0];
    if (!active || !first) return null;
    const rawValue = first.value;
    const displayValue = typeof rawValue === "number"
      ? valueKind === "currency"
        ? formatCurrency(rawValue, defaultCurrency)
        : formatNumber(rawValue, { maximumFractionDigits: 2 })
      : Array.isArray(rawValue)
        ? rawValue.map((item) => String(item)).join(", ")
        : String(rawValue ?? "");
    const label = typeof first.name === "string" || typeof first.name === "number" ? first.name : "";

    return (
      <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-lg">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-sm text-foreground">{displayValue}</p>
      </div>
    );
  };

  const renderDonutChart = (data: readonly StatisticsChartDatum[], valueKind: ChartValueKind, chartTitle: string) => {
    const chartData = [...data];

    return (
      <div className="grid min-w-0 gap-2">
        <RechartsFrame height={STATISTICS_DONUT_CHART_HEIGHT} testId="statistics-chart-frame">
          <PieChart
            accessibilityLayer
            margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
            tabIndex={0}
            title={chartTitle}
          >
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius="58%"
              outerRadius="90%"
              paddingAngle={2}
              cornerRadius={4}
              dataKey="value"
              rootTabIndex={-1}
              strokeWidth={0}
              isAnimationActive={false}
            >
              {chartData.map((entry, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={entry.color}
                  focusable={false}
                  className="transition-all duration-300 hover:opacity-80"
                />
              ))}
            </Pie>
            <RechartsTooltip
              content={(props: unknown) => <CustomTooltip {...readChartTooltipProps(props, valueKind)} />}
              isAnimationActive={false}
              offset={12}
              allowEscapeViewBox={{ x: true, y: true }}
              wrapperStyle={{ pointerEvents: "none" }}
            />
          </PieChart>
        </RechartsFrame>
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-2" role="list">
          {chartData.map((entry) => (
            <div key={entry.name} className="flex min-w-0 items-center gap-1.5 text-xs" role="listitem">
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: entry.color }}
                aria-hidden="true"
              />
              <span className="truncate text-muted-foreground">{entry.name}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderEmptyChart = () => (
    <div
      className="flex min-w-0 items-center justify-center text-muted-foreground"
      style={{ height: 128 }}
    >
      {t("common.noData")}
    </div>
  );

  return (
    <>
      <StatisticsTrendChart
        data={trendData}
        defaultCurrency={defaultCurrency}
        onViewSubscriptionDetails={onViewSubscriptionDetails}
      />

      <section>
        <h2 className="text-lg font-semibold text-foreground mb-4">{t("statistics.breakdown")}</h2>
        <div className="grid min-w-0 gap-6 md:grid-cols-2">
          <div className="min-w-0 rounded-xl border border-border bg-card p-6">
            <h3 className="text-base font-semibold text-foreground text-center mb-1">{t("statistics.categoryView")}</h3>
            <p className="text-xs text-muted-foreground text-center mb-3">{t("statistics.monthlyCostHint")}</p>
            {categoryData.length > 0
              ? renderDonutChart(categoryData, "currency", t("statistics.categoryView"))
              : renderEmptyChart()}
          </div>

          <div className="min-w-0 rounded-xl border border-border bg-card p-6">
            <h3 className="text-base font-semibold text-foreground text-center mb-1">{t("statistics.paymentView")}</h3>
            <p className="text-xs text-muted-foreground text-center mb-3">{t("statistics.subscriptionCountHint")}</p>
            {paymentData.length > 0
              ? renderDonutChart(paymentData, "number", t("statistics.paymentView"))
              : renderEmptyChart()}
          </div>

          <div className="min-w-0 rounded-xl border border-border bg-card p-6 md:col-span-2">
            <h3 className="text-base font-semibold text-foreground text-center mb-1">{t("statistics.costBudget")}</h3>
            <p className="text-xs text-muted-foreground text-center mb-3">
              {t("statistics.monthlyBudgetHint", { amount: formatCurrency(monthlyBudget, defaultCurrency) })}
            </p>
            {renderDonutChart(budgetChartData, "currency", t("statistics.costBudget"))}
            <div className="mt-4 flex flex-col justify-center gap-4 min-[380px]:flex-row min-[380px]:gap-8">
              <div className="text-center">
                <p className="text-2xl font-bold text-foreground">
                  {formatCurrency(Math.min(totalMonthly, monthlyBudgetAmount), defaultCurrency)}
                </p>
                <p className="text-xs text-muted-foreground">{t("statistics.budgetUsed")}</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-emerald-500">
                  {formatCurrency(Math.max(budgetRemaining, 0), defaultCurrency)}
                </p>
                <p className="text-xs text-muted-foreground">{t("statistics.budgetRemaining")}</p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
