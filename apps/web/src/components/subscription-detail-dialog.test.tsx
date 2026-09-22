// 订阅详情测试保护列表/仪表盘/日历共用的只读详情入口，避免备注和网站再次只能在编辑表单中阅读。
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assertDateOnly } from "@/lib/time/date-only";
import { subscriptionCycleFixture } from "@/test/subscription-fixtures";
import type { Subscription, SubscriptionCollectionItem } from "@/types/subscription";
import { SubscriptionDetailDialog } from "./subscription-detail-dialog";

const mocks = vi.hoisted(() => ({
  categories: [
    {
      id: "developer-tools",
      value: "developer-tools",
      labels: { "zh-CN": "开发工具", "en-US": "Developer tools" },
      color: "hsl(200 80% 50%)",
    },
  ],
  paymentMethods: [
    {
      id: "credit-card",
      value: "credit_card",
      labels: { "zh-CN": "信用卡", "en-US": "Credit card" },
      icon: "/icons/payment-methods/credit_card.svg",
    },
  ],
}));

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({
    config: {
      categories: mocks.categories,
      statuses: [],
      paymentMethods: mocks.paymentMethods,
      currencies: [],
    },
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: { notificationReminderDays: 5 },
  }),
}));

vi.mock("@/hooks/use-calendar-feed", () => ({
  useCalendarFeedStatus: () => ({
    data: { enabled: false, feedUrl: undefined },
    isError: false,
    isFetching: false,
    isPending: false,
    refetch: vi.fn(),
  }),
  useCreateCalendarFeed: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useDeleteCalendarFeed: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useRotateCalendarFeed: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));

const baseSubscription: Subscription = {
  id: "sub-1",
  name: "Fastmail",
  logo: undefined,
  price: "159",
  currency: "USD",
  billingCycle: "monthly",
  customDays: undefined,
  customCycleUnit: undefined,
  category: "developer-tools",
  status: "active",
  paymentMethod: "credit_card",
  startDate: assertDateOnly("2026-05-15"),
  nextBillingDate: assertDateOnly("2026-06-15"),
  autoRenew: false,
  autoCalculateNextBillingDate: true,
  trialEndDate: undefined,
  website: "https://fastmail.example/billing",
  notes: "团队年度订阅\n负责人：Alice\nhttps://very-long-example.test/path/to/invoice",
  tags: ["team", "mail"],
  reminderDays: -1,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  extra: {},
  pinned: false,
  publicHidden: false,
};

function testCurrencyConvert(amount: number | string, fromCurrency: string, toCurrency: string): number {
  const value = typeof amount === "number" ? amount : Number(amount);
  if (fromCurrency === toCurrency) return value;
  if (fromCurrency === "USD" && toCurrency === "CNY") return value * 7;
  if (fromCurrency === "CNY" && toCurrency === "USD") return value / 7;
  return value;
}

function renderDetailDialog({
  subscription = baseSubscription,
  open = true,
  onOpenChange = vi.fn(),
  onEditSubscription,
  onRenewSubscription,
  priceReferenceCurrency = "CNY",
  loading = false,
  loadingPreview = subscription,
}: {
  subscription?: Subscription | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onEditSubscription?: (subscription: Subscription) => void;
  onRenewSubscription?: (id: string) => void;
  priceReferenceCurrency?: string | null;
  loading?: boolean;
  loadingPreview?: SubscriptionCollectionItem | null;
} = {}) {
  return {
    onOpenChange,
    ...render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDetailDialog
          open={open}
          onOpenChange={onOpenChange}
          subscription={subscription}
          loadingPreview={loadingPreview}
          today={assertDateOnly("2026-05-18")}
          currencyConvert={testCurrencyConvert}
          currencyRatesReady={true}
          priceReferenceCurrency={priceReferenceCurrency}
          loading={loading}
          {...(onEditSubscription ? { onEditSubscription } : {})}
          {...(onRenewSubscription ? { onRenewSubscription } : {})}
        />
      </TooltipProvider>,
    ),
  };
}

function mockMobile(matches = true) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 639px)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("SubscriptionDetailDialog", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("uses the detail scaffold while the complete detail model is pending", () => {
    const onOpenChange = vi.fn();
    const preview = baseSubscription;
    const { rerender } = renderDetailDialog({
      subscription: null,
      loadingPreview: preview,
      loading: true,
      onOpenChange,
      onEditSubscription: vi.fn(),
    });
    const dialog = screen.getByRole("dialog", { name: "Fastmail" });
    const loadingTitle = within(dialog).getByRole("heading", { name: "Fastmail" });
    const loadingHeader = loadingTitle.parentElement?.parentElement?.parentElement;
    const loadingFrame = screen.getByTestId("subscription-detail-data-loading");
    const scrollBody = loadingFrame.querySelector('[data-subscription-dialog-scroll]');
    const footer = loadingFrame.querySelector('[data-subscription-dialog-footer]');
    expect(scrollBody?.parentElement).toBe(loadingFrame);
    expect(loadingHeader).toHaveClass("shrink-0");
    expect(scrollBody?.nextElementSibling).toBe(footer);
    expect(footer?.parentElement).toBe(loadingFrame);

    rerender(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDetailDialog
          open
          onOpenChange={onOpenChange}
          subscription={baseSubscription}
          loadingPreview={preview}
          today={assertDateOnly("2026-05-18")}
          currencyConvert={testCurrencyConvert}
          currencyRatesReady
          priceReferenceCurrency="CNY"
          onEditSubscription={vi.fn()}
          loading={false}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("dialog", { name: "Fastmail" })).toBe(dialog);
    const resolvedTitle = within(dialog).getByRole("heading", { name: "Fastmail" });
    expect(resolvedTitle.parentElement?.parentElement?.parentElement).toBe(loadingHeader);
    expect(dialog.querySelector('[data-subscription-dialog-scroll]')).toBe(scrollBody);
    expect(dialog.querySelector('[data-subscription-dialog-footer]')).toBe(footer);
    expect(scrollBody?.parentElement).toBe(loadingFrame);
    expect(scrollBody?.nextElementSibling).toBe(footer);
    expect(screen.queryByTestId("subscription-detail-data-loading")).not.toBeInTheDocument();
    expect(screen.getByText("团队年度订阅", { exact: false })).toBeInTheDocument();
  });

  it("keeps buyout and fixed-term loading rows aligned with their daily-cost and date projections", () => {
    const buyoutPreview = { ...baseSubscription, ...subscriptionCycleFixture({ billingCycle: "one-time" }) };
    const buyout = renderDetailDialog({ subscription: null, loadingPreview: buyoutPreview, loading: true });
    const buyoutFacts = screen.getByRole("dialog", { name: "Fastmail" })
      .querySelector('[data-dialog-region="subscription-facts"]');
    expect(buyoutFacts?.querySelectorAll(":scope > div")).toHaveLength(7);
    buyout.unmount();

    const fixedTermPreview = {
      ...baseSubscription,
      ...subscriptionCycleFixture({ billingCycle: "one-time", oneTimeTermCount: 6, oneTimeTermUnit: "month" }),
    };
    renderDetailDialog({ subscription: null, loadingPreview: fixedTermPreview, loading: true });
    const fixedTermFacts = screen.getByRole("dialog", { name: "Fastmail" })
      .querySelector('[data-dialog-region="subscription-facts"]');
    expect(fixedTermFacts?.querySelectorAll(":scope > div")).toHaveLength(8);
  });

  it("renders website, notes, payment method, tags, and inherited reminder in the read-only detail view", () => {
    renderDetailDialog();

    const dialog = screen.getByRole("dialog", { name: "Fastmail" });
    expect(dialog).toHaveAccessibleDescription("查看 Fastmail 的价格、周期、日期、标签、网站和备注。");
    expect(within(dialog).getByText("$159 USD")).toBeInTheDocument();
    expect(within(dialog).getByText("日均支出")).toBeInTheDocument();
    expect(within(dialog).getByText("$5.3")).toHaveClass("tabular-nums");
    expect(within(dialog).getByText("≈ ¥1,113 CNY")).toHaveClass(
      "text-xs",
      "tabular-nums",
      "text-muted-foreground",
    );
    expect(within(dialog).getAllByText("开发工具")).toHaveLength(2);
    expect(within(dialog).getByText("信用卡")).toBeInTheDocument();
    expect(within(dialog).getByText("默认提醒：提前 5 天")).toBeInTheDocument();
    expect(within(dialog).getByText("team")).toBeInTheDocument();
    expect(within(dialog).getByText("mail")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /https:\/\/fastmail\.example\/billing/ })).toHaveAttribute(
      "href",
      "https://fastmail.example/billing",
    );
    const notes = within(dialog).getByText(/团队年度订阅/);
    expect(notes).toHaveClass("whitespace-pre-wrap", "wrap-break-word");
    expect(notes).not.toHaveClass("max-h-48");
    expect(notes).not.toHaveClass("overflow-y-auto");
    expect(within(dialog).getByText(/负责人：Alice/)).toBeInTheDocument();
  });

  it("hides the start-date row when a recurring subscription has an unknown start date", () => {
    renderDetailDialog({
      subscription: {
        ...baseSubscription,
        startDate: null,
        autoCalculateNextBillingDate: false,
      },
    });

    const dialog = screen.getByRole("dialog", { name: "Fastmail" });

    expect(within(dialog).queryByText("开始日期")).not.toBeInTheDocument();
    expect(within(dialog).getByText("2026年6月15日")).toBeInTheDocument();
  });

  it("hides the reference for same-currency subscriptions and disabled settings", () => {
    renderDetailDialog({
      subscription: {
        ...baseSubscription,
        price: "159",
        currency: "CNY",
      },
    });

    const dialog = screen.getByRole("dialog", { name: "Fastmail" });

    expect(within(dialog).getByText("¥159 CNY")).toBeInTheDocument();
    expect(within(dialog).queryByText(/^≈/)).not.toBeInTheDocument();

    renderDetailDialog({ priceReferenceCurrency: null });
    const dialogs = screen.getAllByRole("dialog");
    const latestDialog = dialogs[dialogs.length - 1];
    if (!latestDialog) throw new Error("Missing latest detail dialog");
    expect(latestDialog).not.toHaveTextContent("≈ ¥1,113 CNY");
  });

  it("keeps the reference out of cost-sharing detail rows", () => {
    renderDetailDialog({
      subscription: {
        ...baseSubscription,
        costSharing: {
          enabled: true,
          splitMode: "custom",
          members: [
            { id: "member-1", name: "Bob", currency: "USD", customAmount: "40" },
          ],
        },
      },
    });

    const dialog = screen.getByRole("dialog", { name: "Fastmail" });

    expect(within(dialog).getAllByText(/^≈/)).toHaveLength(1);
    expect(within(dialog).getByText("成员合计")).toBeInTheDocument();
    expect(within(dialog).getByText("你的份额")).toBeInTheDocument();
    expect(within(dialog).getByText("$5.3")).toBeInTheDocument();
  });

  it("shows buyout ownership cost and amortizes one-time fixed terms", () => {
    const buyout = renderDetailDialog({
      subscription: { ...baseSubscription, ...subscriptionCycleFixture({ billingCycle: "one-time" }) },
    });
    const buyoutDialog = screen.getByRole("dialog", { name: "Fastmail" });
    expect(within(buyoutDialog).getByText("持有日均")).toBeInTheDocument();
    expect(within(buyoutDialog).getByText("$39.75")).toBeInTheDocument();
    expect(within(buyoutDialog).getAllByText("长期有效").length).toBeGreaterThan(0);
    expect(within(buyoutDialog).getByText("购买日期")).toBeInTheDocument();
    expect(within(buyoutDialog).queryByText("开始日期")).not.toBeInTheDocument();
    buyout.unmount();

    renderDetailDialog({
      subscription: {
        ...baseSubscription,
        price: "180",
        ...subscriptionCycleFixture({ billingCycle: "one-time", oneTimeTermCount: 6, oneTimeTermUnit: "month" }),
      },
    });
    const fixedTermDialog = screen.getByRole("dialog", { name: "Fastmail" });
    expect(within(fixedTermDialog).getByText("日均支出")).toBeInTheDocument();
    expect(within(fixedTermDialog).getByText("$1")).toBeInTheDocument();
    expect(within(fixedTermDialog).getAllByText("固定服务期").length).toBeGreaterThan(0);
  });

  it("closes the detail dialog before opening the edit flow", () => {
    const onOpenChange = vi.fn();
    const onEditSubscription = vi.fn();
    renderDetailDialog({ onOpenChange, onEditSubscription });

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onEditSubscription).toHaveBeenCalledWith(baseSubscription);
  });

  it("uses a compact desktop footer for detail actions", () => {
    const onEditSubscription = vi.fn();
    const onRenewSubscription = vi.fn();
    renderDetailDialog({ onEditSubscription, onRenewSubscription });

    const dialog = screen.getByRole("dialog", { name: "Fastmail" });
    const editButton = within(dialog).getByRole("button", { name: "编辑" });
    const actions = editButton.parentElement;
    if (!actions) throw new Error("Missing subscription detail action footer");

    expect(actions).toHaveClass("flex", "flex-col", "border-t", "sm:flex-row", "sm:justify-end");
    expect(actions).not.toHaveClass("sm:grid-cols-2");
    expect(within(actions).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "关闭",
      "添加到日历",
      "续订",
      "编辑",
    ]);
  });

  it("focuses the desktop title without including the decorative logo in the dialog name", () => {
    mockMobile(false);
    renderDetailDialog();

    const dialog = screen.getByRole("dialog", { name: "Fastmail" });
    const title = within(dialog).getByRole("heading", { name: "Fastmail" });
    const logo = dialog.querySelector(".subscription-logo-tile");
    const header = title.parentElement?.parentElement?.parentElement;
    const scrollRegions = dialog.querySelectorAll('[data-dialog-scroll-region="subscription-detail"]');
    if (!title.parentElement) throw new Error("Missing desktop subscription detail title stack");
    const category = within(title.parentElement).getByText("开发工具");

    expect(dialog).toHaveClass("h5-dialog-frame", "overflow-hidden");
    expect(header).toHaveClass("shrink-0");
    expect(scrollRegions).toHaveLength(1);
    expect(scrollRegions[0]?.parentElement?.parentElement).toBe(dialog);
    expect(dialog).toHaveAccessibleName("Fastmail");
    expect(title).toHaveAttribute("tabindex", "-1");
    expect(title).toHaveFocus();
    expect(logo?.parentElement).toHaveAttribute("aria-hidden", "true");
    expect(category).toHaveClass("min-w-0", "wrap-break-word");
  });

  it("renders concrete custom billing cycle labels", () => {
    renderDetailDialog({
      subscription: {
        ...baseSubscription,
        ...subscriptionCycleFixture({
          billingCycle: "custom",
          customDays: 2,
          customCycleUnit: "week",
        }),
      },
    });

    const dialog = screen.getByRole("dialog", { name: "Fastmail" });
    expect(within(dialog).getByText("每 2 周")).toBeInTheDocument();
    expect(within(dialog).queryByText("自定义")).not.toBeInTheDocument();
  });

  it("renders disabled reminders in the read-only detail view", () => {
    renderDetailDialog({
      subscription: {
        ...baseSubscription,
        reminderDays: -2,
      },
    });

    expect(within(screen.getByRole("dialog", { name: "Fastmail" })).getByText("不提醒")).toBeInTheDocument();
  });

  it("uses a mobile drawer for small screens", () => {
    mockMobile(true);
    renderDetailDialog();

    const drawer = screen.getByRole("dialog", { name: "Fastmail" });
    const headings = within(drawer).getAllByRole("heading", { name: "Fastmail" });
    const logo = drawer.querySelector(".subscription-logo-tile");
    const scrollRegions = drawer.querySelectorAll('[data-dialog-scroll-region="subscription-detail"]');
    const title = headings[0];
    if (!title?.parentElement) throw new Error("Missing mobile subscription detail title stack");
    const category = within(title.parentElement).getByText("开发工具");
    const header = title.parentElement.parentElement?.parentElement;

    expect(drawer).toHaveClass(
      "h5-drawer-panel",
      "h-[calc(var(--app-viewport-height)-1rem)]",
      "overflow-hidden",
    );
    expect(header).toHaveClass("shrink-0");
    expect(drawer).toHaveAccessibleName("Fastmail");
    expect(headings).toHaveLength(1);
    expect(logo?.parentElement).toHaveAttribute("aria-hidden", "true");
    expect(scrollRegions).toHaveLength(1);
    expect(scrollRegions[0]?.parentElement?.parentElement).toBe(drawer);
    expect(category).toHaveClass("min-w-0", "wrap-break-word");
    expect(within(drawer).getAllByRole("button", { name: "关闭" })).toHaveLength(2);
    expect(within(drawer).getByText(/团队年度订阅/)).toBeInTheDocument();
  });
});
