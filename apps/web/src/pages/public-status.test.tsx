// 公开展示页测试保护无需登录的只读渲染、金额开关和 noindex meta。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import type { PublicStatusResponse } from "@/lib/api/schemas/public-status";
import PublicStatusPage from "./public-status";

const mocks = vi.hoisted(() => ({
  setTheme: vi.fn(),
  theme: "dark" as "light" | "dark" | "system",
  usePublicStatus: vi.fn(),
  useExchangeRates: vi.fn(() => ({
    convert: (amount: number) => amount,
    loading: false,
  })),
}));

vi.mock("react-router", () => ({
  useParams: () => ({ token: "status-token" }),
}));

vi.mock("@/hooks/use-public-status-page", () => ({
  usePublicStatus: mocks.usePublicStatus,
}));

vi.mock("@/hooks/use-exchange-rates", () => ({
  useExchangeRates: mocks.useExchangeRates,
}));

vi.mock("@/lib/theme-provider", () => ({
  useTheme: () => ({
    theme: mocks.theme,
    setTheme: mocks.setTheme,
  }),
}));

vi.mock("@/components/subscription-logo", () => ({
  SubscriptionLogo: ({ name }: { name: string }) => <div data-testid="subscription-logo">{name.slice(0, 1)}</div>,
}));

vi.mock("@/components/ui/truncated-tooltip-text", () => ({
  TruncatedTooltipText: ({ text }: { text: string }) => <span>{text}</span>,
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    locale: "zh-CN",
    t: (key: string, params?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        "publicStatus.activeCount": "活跃/试用",
        "publicStatus.annualTotal": "年化总价",
        "header.toggleTheme": "切换主题",
        "publicStatus.emptyTitle": "暂无可展示订阅",
        "publicStatus.errorDescription": "请稍后刷新重试。",
        "publicStatus.errorTitle": "无法加载公开页",
        "publicStatus.generatedAt": `更新于 ${String(params?.["time"] ?? "")}`,
        "publicStatus.headerMeta": `Renewlet · 更新于 ${String(params?.["time"] ?? "")}`,
        "publicStatus.inactiveCount": "非活跃",
        "publicStatus.inactiveSubtitle": "过期、暂停或取消",
        "publicStatus.listLabel": "公开订阅列表",
        "publicStatus.nextBillingDate": `到期/续费：${String(params?.["date"] ?? "")}`,
        "publicStatus.notFoundDescription": "这个链接不存在、已撤销或已重新生成。",
        "publicStatus.notFoundTitle": "公开页不可用",
        "publicStatus.moneySubtitle": `按 ${String(params?.["currency"] ?? "")} 汇总`,
        "publicStatus.moneySubtitleLive": `按 ${String(params?.["currency"] ?? "")} 实时汇率估算`,
        "publicStatus.moneySubtitleLocked": `按 ${String(params?.["month"] ?? "")} 报表口径`,
        "publicStatus.monthlyTotal": "月均总价",
        "publicStatus.monthlyTotalSubtitle": `日均 ${String(params?.["amount"] ?? "")} · ${String(params?.["basis"] ?? "")}`,
        "publicStatus.ratesLoading": "汇率更新中",
        "publicStatus.purchaseDate": `购买：${String(params?.["date"] ?? "")}`,
        "publicStatus.startDate": `开始：${String(params?.["date"] ?? "")}`,
        "publicStatus.subscriptionDailyAverage": `日均 ${String(params?.["amount"] ?? "")}`,
        "publicStatus.subscriptionDailyCostToDate": `持有日均 ${String(params?.["amount"] ?? "")}`,
        "publicStatus.title": "订阅状态",
        "publicStatus.truncated": "订阅数量较多，仅展示前 500 条。",
        "publicStatus.upcomingCount": "未来 7 天",
        "publicStatus.upcomingSubtitle": "即将到期或续费",
        "publicStatus.updatedAt": `记录更新：${String(params?.["time"] ?? "")}`,
        "publicStatus.visibleCount": "展示订阅",
        "publicStatus.visibleMoneySubtitle": `其中 ${String(params?.["count"] ?? "")} 个计入金额`,
        "subscription.billingCycle.annual": "每年",
        "subscription.billingCycle.monthly": "每月",
        "theme.dark": "深色",
        "theme.light": "浅色",
        "theme.system": "跟随系统",
      };
      return messages[key] ?? key;
    },
    label: (labels: { "zh-CN"?: string; "en-US"?: string }) => labels["zh-CN"] ?? labels["en-US"] ?? "",
    formatCurrency: (amount: number, currency: string) => `${currency} ${amount}`,
    formatDateOnly: (date: string) => date,
    formatDateTime: (date: string) => date,
    formatNumber: (value: number) => String(value),
  }),
}));

const baseResponse: PublicStatusResponse = {
  page: {
    title: "Renewlet",
    showPrices: false,
    asOf: "2026-06-07",
    generatedAt: "2026-06-07T00:00:00.000Z",
    truncated: false,
  },
  subscriptions: [
    {
      name: "Visible Plan",
      category: { value: "developer_tools", label: "开发工具", color: "hsl(210 90% 52%)" },
      status: "active",
      startDate: "2026-05-01",
      nextBillingDate: "2099-06-01",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
    {
      name: "Trial Soon",
      category: { value: "developer_tools", label: "开发工具", color: "hsl(210 90% 52%)" },
      status: "trial",
      startDate: "2026-06-01",
      nextBillingDate: "2026-06-12",
      updatedAt: "2026-06-02T00:00:00.000Z",
    },
    {
      name: "Expired Plan",
      category: { value: "developer_tools", label: "开发工具", color: "hsl(210 90% 52%)" },
      status: "expired",
      startDate: "2026-05-01",
      nextBillingDate: "2026-06-01",
      updatedAt: "2026-06-03T00:00:00.000Z",
    },
  ],
};

function renderPage() {
  return render(<PublicStatusPage />);
}

afterEach(() => {
  document.querySelector('meta[name="robots"]')?.remove();
  mocks.setTheme.mockReset();
  mocks.useExchangeRates.mockClear();
  mocks.theme = "dark";
});

describe("PublicStatusPage", () => {
  it("keeps public subscription cards from forcing price rows into a single-column container layout", () => {
    const source = readFileSync(join(process.cwd(), "src/pages/public-status.tsx"), "utf8");

    expect(source).not.toContain("@container/public-status-card");
    expect(source).not.toContain("@max-xs/public-status-card");
  });

  it("renders a public read-only status panel without prices by default", () => {
    mocks.usePublicStatus.mockReturnValue({ isPending: false, isError: false, data: baseResponse });

    renderPage();

    expect(document.querySelector('meta[name="robots"]')).toHaveAttribute("content", "noindex,nofollow");
    expect(screen.getByRole("heading", { name: "订阅状态" })).toBeInTheDocument();
    expect(screen.getByText("Renewlet · 更新于 2026-06-07T00:00:00.000Z")).toBeInTheDocument();
    expect(screen.queryByText("RENEWLET")).not.toBeInTheDocument();
    expect(screen.queryByText(/需要关注/)).not.toBeInTheDocument();
    expect(screen.queryByText("公开订阅状态正常")).not.toBeInTheDocument();
    expect(screen.queryByText("未来 7 天有 1 个续费")).not.toBeInTheDocument();
    expect(screen.queryByText("这是只读公开状态面板，仅展示已公开的订阅状态和必要日期。")).not.toBeInTheDocument();
    expect(screen.getByText("展示订阅")).toBeInTheDocument();
    expect(screen.getByText("活跃/试用")).toBeInTheDocument();
    expect(screen.getByText("未来 7 天")).toBeInTheDocument();
    expect(screen.getByText("非活跃")).toBeInTheDocument();
    expect(screen.queryByText("当前公开可见")).not.toBeInTheDocument();
    expect(screen.queryByText("状态正常运行")).not.toBeInTheDocument();
    expect(screen.getByText("即将到期或续费")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getAllByText("1")).toHaveLength(2);
    expect(screen.getByText("Visible Plan")).toBeInTheDocument();
    expect(screen.getByText("Trial Soon")).toBeInTheDocument();
    expect(screen.getByText("Expired Plan")).toBeInTheDocument();
    expect(screen.queryByText("隐藏金额")).not.toBeInTheDocument();
    expect(screen.queryByText("显示金额")).not.toBeInTheDocument();
    expect(screen.queryByText("USD 12")).not.toBeInTheDocument();
    expect(screen.queryByText(/日均/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换主题" })).toBeInTheDocument();
    expect(mocks.useExchangeRates).not.toHaveBeenCalled();
  });

  it("keeps the buyout purchase date visible when price and billing fields are hidden", () => {
    mocks.usePublicStatus.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        ...baseResponse,
        subscriptions: [{
          ...baseResponse.subscriptions[0]!,
          name: "Lifetime License",
          nextBillingDate: null,
        }],
      },
    });

    renderPage();

    const card = screen.getByText("Lifetime License").closest("article");
    if (!card) throw new Error("Missing price-hidden buyout card");
    expect(within(card).getByText("购买：2026-05-01")).toBeInTheDocument();
    expect(within(card).queryByText("开始：2026-05-01")).not.toBeInTheDocument();
    expect(within(card).queryByText(/日均/)).not.toBeInTheDocument();
    expect(within(card).queryByText("长期有效")).not.toBeInTheDocument();
  });

  it("opens a compact theme menu with light, dark, and system choices", async () => {
    const user = userEvent.setup();
    mocks.usePublicStatus.mockReturnValue({ isPending: false, isError: false, data: baseResponse });

    renderPage();

    await user.click(screen.getByRole("button", { name: "切换主题" }));

    expect(screen.getByRole("menuitemradio", { name: /浅色/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /深色/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /跟随系统/ })).toBeInTheDocument();
  });

  it("switches the public page theme mode to system from the menu", async () => {
    const user = userEvent.setup();
    mocks.usePublicStatus.mockReturnValue({ isPending: false, isError: false, data: baseResponse });

    renderPage();

    await user.click(screen.getByRole("button", { name: "切换主题" }));
    await user.click(screen.getByRole("menuitemradio", { name: /跟随系统/ }));

    expect(mocks.setTheme).toHaveBeenCalledWith("system");
  });

  it("shows monthly and annual totals when the public response includes amount fields", () => {
    mocks.usePublicStatus.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        ...baseResponse,
        page: {
          ...baseResponse.page,
          showPrices: true,
          currency: "USD",
          exchangeRateBasis: {
            status: "locked",
            month: "2026-06",
            base: "USD",
            rates: { USD: 1, CNY: 7 },
            sourceDate: "2026-06-01",
            capturedAt: "2026-06-07T00:00:00.000Z",
          },
        },
        subscriptions: [
          { ...baseResponse.subscriptions[0]!, price: "120", currency: "USD", billingCycle: "annual" },
          { ...baseResponse.subscriptions[1]!, price: "10", currency: "USD", billingCycle: "monthly" },
        ],
      },
    });

    renderPage();

    expect(screen.getByText("月均总价")).toBeInTheDocument();
    expect(screen.getByText("年化总价")).toBeInTheDocument();
    expect(screen.getByText("USD 20")).toBeInTheDocument();
    expect(screen.getByText("USD 240")).toBeInTheDocument();
    expect(screen.getByText("日均 $0.67 · 按 2026-06 报表口径")).toBeInTheDocument();
    expect(screen.getByText("按 2026-06 报表口径")).toBeInTheDocument();
    expect(screen.getAllByText("日均 $0.33")).toHaveLength(2);
    expect(screen.getByText("其中 2 个计入金额")).toBeInTheDocument();
    expect(screen.getByText("USD 120")).toBeInTheDocument();
    expect(screen.getByText("每年")).toBeInTheDocument();
    expect(screen.queryByText("显示金额")).not.toBeInTheDocument();
    expect(mocks.useExchangeRates).not.toHaveBeenCalled();
  });

  it("uses live conversion once for monthly and daily totals", () => {
    const convert = vi.fn((amount: number | string, from?: string) => from === "CNY" ? Number(amount) / 2 : Number(amount));
    mocks.useExchangeRates.mockReturnValueOnce({
      convert,
      loading: false,
    });
    mocks.usePublicStatus.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        ...baseResponse,
        page: {
          ...baseResponse.page,
          showPrices: true,
          currency: "USD",
          exchangeRateBasis: { status: "live", month: "2026-06" },
        },
        subscriptions: [
          { ...baseResponse.subscriptions[0]!, price: "30", currency: "CNY", billingCycle: "monthly" },
        ],
      },
    });

    renderPage();

    expect(screen.getByText("USD 15")).toBeInTheDocument();
    expect(screen.getByText("日均 $0.5 · 按 USD 实时汇率估算")).toBeInTheDocument();
    expect(screen.getByText("日均 ¥1")).toBeInTheDocument();
    expect(mocks.useExchangeRates).toHaveBeenCalledTimes(1);
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it("shows ownership-to-date buyout cost and fixed-term amortization", () => {
    mocks.usePublicStatus.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        ...baseResponse,
        page: {
          ...baseResponse.page,
          showPrices: true,
          currency: "USD",
          exchangeRateBasis: {
            status: "locked",
            month: "2026-06",
            base: "USD",
            rates: { USD: 1 },
            sourceDate: "2026-06-01",
            capturedAt: "2026-06-07T00:00:00.000Z",
          },
        },
        subscriptions: [
          {
            ...baseResponse.subscriptions[0]!,
            name: "Buyout",
            price: "199",
            currency: "USD",
            billingCycle: "one-time",
            nextBillingDate: null,
          },
          {
            ...baseResponse.subscriptions[1]!,
            name: "Fixed term",
            price: "180",
            currency: "USD",
            billingCycle: "one-time",
            oneTimeTermCount: 6,
            oneTimeTermUnit: "month",
          },
          { ...baseResponse.subscriptions[2]!, name: "Free recurring", price: "0", currency: "USD", billingCycle: "monthly" },
        ],
      },
    });

    renderPage();

    const buyoutCard = screen.getByText("Buyout").closest("article");
    const fixedTermCard = screen.getByText("Fixed term").closest("article");
    const freeRecurringCard = screen.getByText("Free recurring").closest("article");
    if (!buyoutCard || !fixedTermCard || !freeRecurringCard) throw new Error("Missing public subscription cards");
    expect(within(buyoutCard).getByText("持有日均 $5.24")).toBeInTheDocument();
    expect(within(buyoutCard).getByText("购买：2026-05-01")).toBeInTheDocument();
    expect(within(buyoutCard).queryByText(/到期\/续费/)).not.toBeInTheDocument();
    expect(within(buyoutCard).getByText("长期有效")).toBeInTheDocument();
    expect(within(fixedTermCard).getByText("日均 $1")).toBeInTheDocument();
    expect(within(fixedTermCard).getByText("固定服务期")).toBeInTheDocument();
    expect(within(freeRecurringCard).getByText("日均 $0")).toBeInTheDocument();
    expect(screen.getByText("其中 1 个计入金额")).toBeInTheDocument();
    const upcomingCard = screen.getByText("未来 7 天").closest<HTMLDivElement>("div.relative");
    if (!upcomingCard) throw new Error("Missing upcoming public summary card");
    expect(within(upcomingCard).getByText("1")).toBeInTheDocument();
    expect(mocks.useExchangeRates).not.toHaveBeenCalled();
  });

  it("renders one concise empty state for a public page without visible subscriptions", () => {
    mocks.usePublicStatus.mockReturnValue({
      isPending: false,
      isError: false,
      data: { ...baseResponse, subscriptions: [] },
    });

    renderPage();

    expect(screen.getAllByRole("heading", { name: "暂无可展示订阅" })).toHaveLength(1);
    expect(screen.queryByText("当前公开链接没有可见订阅。")).not.toBeInTheDocument();
  });

  it("hides the start-date line when a public subscription has no known start date", () => {
    mocks.usePublicStatus.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        ...baseResponse,
        subscriptions: [
          {
            ...baseResponse.subscriptions[0]!,
            startDate: null,
          },
        ],
      },
    });

    renderPage();

    expect(screen.getByText("Visible Plan")).toBeInTheDocument();
    expect(screen.queryByText("开始：null")).not.toBeInTheDocument();
    expect(screen.queryByText("开始：2026-05-01")).not.toBeInTheDocument();
    expect(screen.getByText("到期/续费：2099-06-01")).toBeInTheDocument();
  });

  it("renders a not-found state for revoked or unknown tokens", () => {
    mocks.usePublicStatus.mockReturnValue({
      isPending: false,
      isError: true,
      data: undefined,
      error: new ApiError("not found", 404),
    });

    renderPage();

    expect(screen.getByRole("heading", { name: "公开页不可用" })).toBeInTheDocument();
    expect(screen.getByText("这个链接不存在、已撤销或已重新生成。")).toBeInTheDocument();
  });

  it("restores an existing robots meta when unmounted", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "robots");
    meta.setAttribute("content", "index,follow");
    document.head.appendChild(meta);
    mocks.usePublicStatus.mockReturnValue({ isPending: false, isError: false, data: baseResponse });

    const { rerender } = render(<PublicStatusPage />);

    expect(meta).toHaveAttribute("content", "noindex,nofollow");

    rerender(null);

    expect(meta).toHaveAttribute("content", "index,follow");
  });
});
