// SpendingChart 测试保护首页分类支出口径，确保图表只统计有效活跃订阅和统一月折算金额。
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import type { Subscription } from "@/types/subscription";
import { assertDateOnly } from "@/lib/time/date-only";
import {
  subscriptionCycleFixture,
  type SubscriptionFixtureOverrides,
} from "@/test/subscription-fixtures";
import { SpendingChart } from "./spending-chart";

type SubscriptionBaseFixture = Omit<Subscription, "billingCycle" | "customDays" | "customCycleUnit" | "oneTimeTermCount" | "oneTimeTermUnit">;
type SubscriptionOverrides = SubscriptionFixtureOverrides<Subscription>;

const mocks = vi.hoisted(() => ({
  rechartsCellProps: [] as Array<Record<string, unknown>>,
  rechartsLegendProps: [] as Array<Record<string, unknown>>,
  rechartsPieChartProps: [] as Array<Record<string, unknown>>,
  rechartsPieProps: [] as Array<Record<string, unknown>>,
  rechartsResponsiveContainerProps: [] as Array<Record<string, unknown>>,
  rechartsTooltipProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("recharts", () => ({
  Cell: (props: Record<string, unknown>) => {
    mocks.rechartsCellProps.push(props);
    return null;
  },
  Legend: (props: Record<string, unknown>) => {
    mocks.rechartsLegendProps.push(props);
    return <div data-testid="recharts-legend" />;
  },
  Pie: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
    mocks.rechartsPieProps.push(props);
    return <div>{children}</div>;
  },
  PieChart: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
    mocks.rechartsPieChartProps.push(props);
    return <div>{children}</div>;
  },
  ResponsiveContainer: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
    mocks.rechartsResponsiveContainerProps.push(props);
    return <div>{children}</div>;
  },
  Tooltip: (props: Record<string, unknown>) => {
    mocks.rechartsTooltipProps.push(props);
    const renderContent = props["content"] as
      | ((args: { active: boolean; payload: Array<{ name: string; value: number }> }) => ReactNode)
      | undefined;

    return (
      <div data-testid="chart-tooltip">
        {renderContent?.({
          active: true,
          payload: [{ name: "生产力", value: 20 }],
        })}
      </div>
    );
  },
}));

function subscription(overrides: SubscriptionOverrides = {}): Subscription {
  const base: SubscriptionBaseFixture = {
    id: "sub",
    name: "Service",
    logo: undefined,
    price: "20",
    currency: "CNY",
    category: "productivity",
    status: "active",
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-01-01"),
    nextBillingDate: assertDateOnly("2099-01-05"),
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    trialEndDate: undefined,
    website: undefined,
    notes: undefined,
    tags: [],
    reminderDays: 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {},
    pinned: false,
    publicHidden: false,
  };

  return {
    ...base,
    ...overrides,
    ...subscriptionCycleFixture(overrides),
  };
}

describe("SpendingChart", () => {
  beforeEach(() => {
    mocks.rechartsCellProps.length = 0;
    mocks.rechartsLegendProps.length = 0;
    mocks.rechartsPieChartProps.length = 0;
    mocks.rechartsPieProps.length = 0;
    mocks.rechartsResponsiveContainerProps.length = 0;
    mocks.rechartsTooltipProps.length = 0;
  });

  function renderSpendingChart(
    subscriptions: Subscription[],
    convert: (amount: number | string, fromCurrency: string, toCurrency: string) => number = (amount) => Number(amount),
  ) {
    return render(
      <SpendingChart
        subscriptions={subscriptions}
        categories={DEFAULT_CUSTOM_CONFIG.categories}
        defaultCurrency="CNY"
        today="2026-05-18"
        convert={convert}
      />,
    );
  }

  it("excludes buyouts before currency conversion", () => {
    const convert = vi.fn((amount: number | string) => Number(amount));
    renderSpendingChart([subscription({ billingCycle: "one-time" })], convert);

    expect(screen.getByText("暂无订阅数据")).toBeInTheDocument();
    expect(convert).not.toHaveBeenCalled();
  });

  it("disables tooltip animation while keeping the custom content", () => {
    renderSpendingChart([subscription()]);

    expect(mocks.rechartsTooltipProps).toEqual([
      expect.objectContaining({
        isAnimationActive: false,
        offset: 12,
        allowEscapeViewBox: { x: true, y: true },
        wrapperStyle: { pointerEvents: "none" },
      }),
    ]);
    expect(screen.getByTestId("chart-tooltip")).toHaveTextContent("生产力");
    expect(screen.getByTestId("chart-tooltip")).toHaveTextContent("¥20 CNY / 月");
  });

  it("keeps the legend outside Recharts so it cannot shrink the pie plot area", () => {
    renderSpendingChart([subscription()]);

    expect(mocks.rechartsLegendProps).toHaveLength(0);
    expect(mocks.rechartsPieChartProps).toEqual([
      expect.objectContaining({
        accessibilityLayer: true,
        margin: { top: 4, right: 4, bottom: 4, left: 4 },
        tabIndex: 0,
        title: "支出分布",
      }),
    ]);
    expect(mocks.rechartsPieProps).toEqual([
      expect.objectContaining({
        cy: "50%",
        innerRadius: "56%",
        outerRadius: "90%",
        rootTabIndex: -1,
      }),
    ]);
    expect(mocks.rechartsCellProps.length).toBeGreaterThan(0);
    for (const props of mocks.rechartsCellProps) {
      expect(props["focusable"]).toBe(false);
    }
    expect(within(screen.getByRole("list")).getByText("生产力")).toBeInTheDocument();
  });

  it("gives Recharts positive dimensions before ResizeObserver reports layout", () => {
    renderSpendingChart([subscription()]);

    expect(screen.getByTestId("spending-chart-frame")).toHaveClass("recharts-frame");
    expect(mocks.rechartsResponsiveContainerProps).toHaveLength(1);
    const props = mocks.rechartsResponsiveContainerProps[0]!;
    const initialDimension = props["initialDimension"] as { width: number; height: number };

    expect(props).toEqual(
      expect.objectContaining({
        width: "100%",
        height: 190,
        minWidth: 0,
        debounce: 50,
      }),
    );
    expect(props["height"]).not.toBe("100%");
    expect(initialDimension.width).toBeGreaterThan(0);
    expect(initialDimension.height).toBe(190);
  });
});
