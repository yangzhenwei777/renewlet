// 日历弹窗可访问性测试保护移动/桌面详情弹层的标题、焦点和订阅入口语义。
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import { TooltipProvider } from "@/components/ui/tooltip";
import { subscriptionQueryKeys } from "@/hooks/subscription-query-cache";
import type { Subscription } from "@/types/subscription";
import {
  subscriptionCycleFixture,
  type SubscriptionFixtureOverrides,
} from "@/test/subscription-fixtures";
import { SubscriptionCalendar } from "./subscription-calendar";

type SubscriptionBaseFixture = Omit<Subscription, "billingCycle" | "customDays" | "customCycleUnit" | "oneTimeTermCount" | "oneTimeTermUnit">;
type SubscriptionOverrides = SubscriptionFixtureOverrides<Subscription>;

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({
    config: {
      categories: [{ id: "productivity", value: "productivity", labels: { "zh-CN": "效率工具", "en-US": "Productivity" } }],
      statuses: [],
      paymentMethods: [],
      currencies: [],
    },
  }),
}));

vi.mock("@/hooks/use-exchange-rates", () => ({
  useExchangeRates: () => ({
    convert: (amount: number) => amount,
    getCurrencySymbol: (currency: string) => (currency === "USD" ? "$" : currency),
    loading: false,
    sourceDate: "2026-08-01",
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: { defaultCurrency: "USD", notificationReminderDays: 5 },
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

function subscription(overrides: SubscriptionOverrides = {}): Subscription {
  const base: SubscriptionBaseFixture = {
    id: "sub-1",
    name: "Aws",
    logo: undefined,
    price: "15",
    currency: "USD",
    category: "productivity",
    status: "active",
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-05-14"),
    nextBillingDate: assertDateOnly("2026-05-14"),
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    trialEndDate: undefined,
    website: undefined,
    notes: undefined,
    reminderDays: 3,
    tags: [],
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

function renderCalendar(subscriptions: Subscription[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  for (const item of subscriptions) {
    queryClient.setQueryData(subscriptionQueryKeys.detail(item.id), item);
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <SubscriptionCalendar
          subscriptions={subscriptions}
          currentMonth={new Date(2026, 4, 1)}
          onCurrentMonthChange={vi.fn()}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function mockMobileCalendar(matches = true) {
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

describe("SubscriptionCalendar dialogs", () => {
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("describes the subscription detail dialog", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));

    renderCalendar([subscription()]);

    fireEvent.click(screen.getByRole("button", { name: "Aws" }));

    expect(screen.getByRole("dialog", { name: /Aws/ })).toHaveAccessibleDescription(
      "查看 Aws 的价格、周期、日期、标签、网站和备注。",
    );
  });

  it("renders the detail dialog logo on the unified theme-aware logo surface without cropping", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));

    renderCalendar([
      subscription({
        name: "Apple",
        logo: "https://example.com/apple.svg",
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Apple" }));

    const logo = screen.getByAltText("Apple");
    const logoTile = logo.closest(".subscription-logo-tile");

    expect(logo).toHaveClass("subscription-logo-image", "object-contain");
    expect(logo).not.toHaveClass("media-thumbnail-image", "invert", "brightness-125", "mix-blend-screen");
    expect(logo).not.toHaveClass("object-cover");
    expect(logoTile).not.toBeNull();
    expect(logoTile).not.toHaveClass("media-thumbnail-canvas");
    expect(logoTile).not.toHaveClass("bg-linear-to-br");
  });

  it("uses the same detail dialog logo path for dark transparent logos", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));

    renderCalendar([
      subscription({
        name: "Better Stack Uptime Team",
        logo: "https://example.com/better-stack-dark-logo.svg",
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Better Stack Uptime Team" }));

    const logo = screen.getByAltText("Better Stack Uptime Team");

    expect(logo).toHaveClass("subscription-logo-image", "object-contain");
    expect(logo.closest(".subscription-logo-tile")).not.toBeNull();
  });

  it("keeps the detail dialog initials fallback inside the unified logo surface", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));

    renderCalendar([subscription({ name: "dmit", logo: undefined })]);

    fireEvent.click(screen.getByRole("button", { name: "dmit" }));

    const initials = screen.getByText("DM");
    const logoTile = initials.closest(".subscription-logo-tile");

    expect(initials).toHaveClass("subscription-logo-fallback");
    expect(logoTile).not.toBeNull();
    expect(logoTile).not.toHaveClass("bg-linear-to-br");
  });

  it("renders inherited reminder days in the detail dialog", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));

    renderCalendar([subscription({ reminderDays: -1 })]);

    fireEvent.click(screen.getByRole("button", { name: "Aws" }));

    expect(screen.getByText("默认提醒：提前 5 天")).toBeInTheDocument();
  });

  it("opens add-to-calendar actions from the detail dialog", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));

    renderCalendar([subscription({ name: "Fastmail", website: "https://fastmail.example" })]);

    fireEvent.click(screen.getByRole("button", { name: "Fastmail" }));
    fireEvent.click(screen.getByRole("button", { name: "添加到日历" }));

    expect(screen.getByRole("dialog", { name: "添加到日历" })).toBeInTheDocument();
    expect(screen.getByText("为「Fastmail」选择持续同步，或单次添加到日历。")).toBeInTheDocument();
    const generateButton = screen.getByRole("button", { name: "生成订阅链接" });
    expect(generateButton).toHaveClass("bg-primary");
    expect(screen.queryByRole("link", { name: "打开系统日历" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 ICS 文件" })).toHaveClass("border");
    expect(screen.getByText("在线日历服务")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "用 Google Calendar 打开" })).toHaveAttribute(
      "href",
      expect.stringContaining("calendar.google.com"),
    );
    expect(screen.queryByRole("button", { name: "用 Google Calendar 打开" })).not.toBeInTheDocument();
  });

  it("describes the day subscription list dialog", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));

    renderCalendar([
      subscription({ id: "sub-1", name: "Aws" }),
      subscription({ id: "sub-2", name: "Netflix" }),
      subscription({ id: "sub-3", name: "OpenAI" }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "+1 更多" }));

    expect(screen.getByRole("dialog", { name: "5月14日 续费/到期" })).toHaveAccessibleDescription(
      "选择 5月14日 要查看的订阅。",
    );
  });

  it("renders day list logos on the unified theme-aware logo surface without cropping", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));

    renderCalendar([
      subscription({ id: "sub-1", name: "Apple", logo: "https://example.com/apple.svg" }),
      subscription({ id: "sub-2", name: "Better Stack Uptime Team", logo: "https://example.com/better-stack.svg" }),
      subscription({ id: "sub-3", name: "OpenAI" }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "+1 更多" }));

    const logo = screen.getByAltText("Better Stack Uptime Team");
    const logoTile = logo.closest(".subscription-logo-tile");

    expect(logo).toHaveClass("subscription-logo-image", "object-contain");
    expect(logo).not.toHaveClass("object-cover");
    expect(logoTile).not.toBeNull();
    expect(logoTile).not.toHaveClass("media-thumbnail-canvas");
    expect(logoTile).not.toHaveClass("bg-linear-to-br");
  });

  it("renders the mobile agenda with only active and trial subscriptions", async () => {
    mockMobileCalendar();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));

    renderCalendar([
      subscription({ id: "sub-1", name: "Aws", status: "active", nextBillingDate: assertDateOnly("2026-05-14") }),
      subscription({ id: "sub-2", name: "Netflix", status: "trial", nextBillingDate: assertDateOnly("2026-05-16"), billingCycle: "annual", price: "120" }),
      subscription({ id: "sub-3", name: "Paused Cloud", status: "paused", nextBillingDate: assertDateOnly("2026-05-14") }),
      subscription({ id: "sub-4", name: "Cancelled Tool", status: "cancelled", nextBillingDate: assertDateOnly("2026-05-16") }),
    ]);

    expect(screen.getByText("本月续费/到期明细")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Aws/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Netflix/ })).toBeInTheDocument();
    expect(screen.getByText("每月")).toBeInTheDocument();
    expect(screen.getByText("每年")).toBeInTheDocument();
    expect(screen.queryByText("Paused Cloud")).not.toBeInTheDocument();
    expect(screen.queryByText("Cancelled Tool")).not.toBeInTheDocument();
  });

  it("includes one-time fixed term expiries in the calendar while hiding buyouts", async () => {
    mockMobileCalendar();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));

    renderCalendar([
      subscription({
        id: "fixed-term",
        name: "Discounted membership",
        billingCycle: "one-time",
        oneTimeTermCount: 6,
        oneTimeTermUnit: "month",
        nextBillingDate: assertDateOnly("2026-05-14"),
      }),
      subscription({
        id: "buyout",
        name: "Lifetime license",
        billingCycle: "one-time",
        nextBillingDate: assertDateOnly("2026-05-14"),
      }),
    ]);

    expect(screen.getByRole("button", { name: /Discounted membership/ })).toBeInTheDocument();
    expect(screen.queryByText("Lifetime license")).not.toBeInTheDocument();
  });

  it("opens the mobile day drawer from a renewal date marker", async () => {
    mockMobileCalendar();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));

    renderCalendar([
      subscription({ id: "sub-1", name: "Aws" }),
      subscription({ id: "sub-2", name: "Netflix" }),
      subscription({ id: "sub-3", name: "OpenAI" }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "5月14日 3 个事件" }));

    expect(screen.getByRole("dialog", { name: "5月14日 续费/到期" })).toHaveAccessibleDescription(
      "选择 5月14日 要查看的订阅。",
    );
  });

  it("opens subscription details from the mobile agenda list", async () => {
    mockMobileCalendar();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));

    renderCalendar([subscription()]);

    fireEvent.click(screen.getByRole("button", { name: /Aws/ }));

    expect(screen.getByRole("dialog", { name: /Aws/ })).toHaveAccessibleDescription(
      "查看 Aws 的价格、周期、日期、标签、网站和备注。",
    );
  });
});
