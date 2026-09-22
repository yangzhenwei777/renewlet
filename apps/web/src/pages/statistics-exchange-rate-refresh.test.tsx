import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import Statistics from "./statistics";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  loading: false,
  isRefreshing: false,
  error: null as string | null,
  errorDetails: null as { message: string; responseText: string } | null,
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: mocks.toastSuccess },
}));

vi.mock("@/components/header", () => ({ Header: () => null }));
vi.mock("@/components/edit-subscription-dialog", () => ({ EditSubscriptionDialog: () => null }));
vi.mock("@/components/renew-subscription-dialog-loader", () => ({ DeferredRenewSubscriptionDialog: () => null }));
vi.mock("@/components/subscription-detail-dialog", () => ({ SubscriptionDetailDialog: () => null }));
vi.mock("@/components/statistics-charts-loader", () => ({ DeferredStatisticsCharts: () => null }));

vi.mock("@/hooks/use-report-exchange-rates", () => ({
  useReportExchangeRates: () => ({
    convert: (amount: number | string) => Number(amount),
    loading: mocks.loading,
    isRefreshing: mocks.isRefreshing,
    refresh: mocks.refresh,
    lastUpdated: new Date("2026-08-06T00:00:00.000Z"),
    error: mocks.error,
    errorDetails: mocks.errorDetails,
    sourceDate: "2026-08-01",
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: {
      monthlyBudget: "0",
      defaultCurrency: "CNY",
      timezone: "UTC",
      exchangeRateProvider: "frankfurter",
      subscriptionPriceReferenceEnabled: false,
      subscriptionPriceReferenceCurrency: "USD",
    },
    isPending: false,
  }),
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  useSubscriptionAnalytics: () => ({ data: [], isPending: false }),
  useSubscriptionFacets: () => ({ data: { tags: [] } }),
}));

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({ config: {} }),
}));

vi.mock("@/modules/subscriptions/application/use-statistics-model", () => ({
  useStatisticsModel: () => ({
    activeCount: 0,
    totalMonthly: 0,
    totalDaily: 0,
    totalAnnual: 0,
    avgMonthlyPerSub: 0,
    mostExpensive: null,
    thisMonthDue: 0,
    budgetUsedPercent: 0,
    budgetRemaining: 0,
    inactiveCount: 0,
    monthlySavings: 0,
    annualSavings: 0,
    trendData: [],
    categoryData: [],
    paymentData: [],
    budgetChartData: [],
  }),
}));

vi.mock("@/modules/subscriptions/application/use-subscription-crud", () => ({
  useSubscriptionCrud: () => ({
    editingSubscription: null,
    editingCollectionItem: null,
    editDialogOpen: false,
    renewingSubscription: null,
    renewingCollectionItem: null,
    renewDialogOpen: false,
    editDetailPending: false,
    renewDetailPending: false,
    renewError: null,
    renewSubmitting: false,
    renewRestoreFocusRef: { current: null },
    handleAddSubscription: vi.fn(),
    handleEditSubscription: vi.fn(),
    handleRenewSubscription: vi.fn(),
    handleSubmitRenewSubscription: vi.fn(),
    handleSaveSubscription: vi.fn(),
    handleEditDialogOpenChange: vi.fn(),
    handleRenewDialogOpenChange: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-subscription-detail-dialog", () => ({
  useSubscriptionDetailDialog: () => ({
    detailDialogOpen: false,
    selectedDetailSubscription: null,
    selectedDetailCollectionItem: null,
    detailPending: false,
    handleViewDetails: vi.fn(),
    handleDetailDialogOpenChange: vi.fn(),
  }),
}));

function renderPage() {
  return render(
    <TooltipProvider>
      <Statistics />
    </TooltipProvider>,
  );
}

describe("Statistics exchange-rate refresh", () => {
  beforeEach(() => {
    mocks.refresh.mockReset().mockResolvedValue({ status: "succeeded", warning: null });
    mocks.toastSuccess.mockReset();
    mocks.loading = false;
    mocks.isRefreshing = false;
    mocks.error = null;
    mocks.errorDetails = null;
  });

  it("shows pending semantics without hiding locked report content", () => {
    mocks.isRefreshing = true;
    renderPage();

    const button = screen.getByRole("button", { name: "刷新中..." });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("总体统计")).toBeInTheDocument();
  });

  it("reports a successful manual refresh once", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "刷新汇率" }));

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("最新汇率数据已获取"));
  });

  it("keeps failure inline with raw details and does not report success", async () => {
    const user = userEvent.setup();
    mocks.error = "网络请求失败";
    mocks.errorDetails = {
      message: "Too Many Requests",
      responseText: "<html>rate limited</html>",
    };
    mocks.refresh.mockResolvedValue({
      status: "failed",
      error: mocks.error,
      errorDetails: mocks.errorDetails,
    });
    renderPage();

    expect(screen.getByRole("alert")).toHaveTextContent("汇率获取失败，当前使用备用汇率。网络请求失败");
    await user.click(screen.getByRole("button", { name: "刷新汇率" }));
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "查看错误响应" }));
    expect(screen.getByTestId("exchange-rates-raw-error-response-dialog")).toHaveTextContent("rate limited");
  });
});
