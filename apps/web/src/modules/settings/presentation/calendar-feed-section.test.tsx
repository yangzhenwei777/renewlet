import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assertDateOnly } from "@/lib/time/date-only";
import type { SettingsCalendarFeedController } from "../application/use-calendar-feed-settings-controller";
import { CalendarFeedSection } from "./calendar-feed-section";

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({
    config: {
      categories: [],
      currencies: [],
      paymentMethods: [],
      statuses: [{ id: "active", value: "active", labels: { "zh-CN": "使用中", "en-US": "Active" } }],
    },
  }),
}));

const globalFeed = {
  enabled: true,
  feedUrl: "https://example.com/calendar/renewals.ics?token=all",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const subscriptionFeed: NonNullable<SettingsCalendarFeedController["subscriptions"]["data"]>["items"][number] = {
  id: "cal-sub",
  feedUrl: "https://example.com/calendar/renewals.ics?token=subscription",
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
  subscription: {
    id: "sub-1",
    name: "Fastmail Enterprise Plan With A Long Name",
    status: "active",
    nextBillingDate: assertDateOnly("2026-09-01"),
  },
};

const secondSubscriptionFeed = {
  ...subscriptionFeed,
  id: "cal-sub-2",
  feedUrl: "https://example.com/calendar/renewals.ics?token=subscription-2",
  subscription: { ...subscriptionFeed.subscription, id: "sub-2", name: "GitHub" },
};

type ControllerOverrides = Partial<Omit<SettingsCalendarFeedController, "global" | "subscriptions">> & {
  global?: Partial<SettingsCalendarFeedController["global"]>;
  subscriptions?: Partial<SettingsCalendarFeedController["subscriptions"]>;
};

function controller(overrides: ControllerOverrides = {}): SettingsCalendarFeedController {
  const { global, subscriptions, ...controllerOverrides } = overrides;
  return {
    global: {
      data: globalFeed,
      error: null,
      hasData: true,
      isInitialLoading: false,
      isRefreshing: false,
      retry: vi.fn().mockResolvedValue(undefined),
      ...global,
    },
    subscriptions: {
      data: {
        items: [subscriptionFeed],
        total: 1,
        hasMore: false,
      },
      error: null,
      hasData: true,
      isInitialLoading: false,
      isRefreshing: false,
      isLoadingMore: false,
      retry: vi.fn().mockResolvedValue(undefined),
      loadMore: vi.fn().mockResolvedValue(undefined),
      ...subscriptions,
    },
    pendingTargetKey: null,
    pendingKind: null,
    create: vi.fn<SettingsCalendarFeedController["create"]>().mockResolvedValue(true),
    rotate: vi.fn<SettingsCalendarFeedController["rotate"]>().mockResolvedValue(true),
    revoke: vi.fn<SettingsCalendarFeedController["revoke"]>().mockResolvedValue(true),
    copyUrl: vi.fn<SettingsCalendarFeedController["copyUrl"]>().mockResolvedValue(undefined),
    openSystem: vi.fn<SettingsCalendarFeedController["openSystem"]>().mockResolvedValue(undefined),
    ...controllerOverrides,
  };
}

function view(value: SettingsCalendarFeedController) {
  return (
    <TooltipProvider delayDuration={0}>
      <CalendarFeedSection controller={value} />
    </TooltipProvider>
  );
}

describe("CalendarFeedSection", () => {
  it("uses tabs as the only scope headings and keeps actions concise", async () => {
    const user = userEvent.setup();
    const state = controller();
    render(view(state));

    expect(screen.getByText("将未来续费和到期日期持续同步到系统日历。")).toBeInTheDocument();
    expect(screen.getByText("全部续费 · 已启用")).toBeInTheDocument();
    expect(screen.getByText("单个订阅 · 1 个")).toBeInTheDocument();
    const manage = screen.getByRole("button", { name: "管理" });
    expect(manage).toHaveClass("h-11", "border-border");
    await user.click(manage);

    const dialog = screen.getByRole("dialog", { name: "日历订阅" });
    expect(dialog).toHaveClass("max-w-3xl", "bg-card");
    expect(within(dialog).getByText("管理全部续费和单个订阅的持续同步链接。")).toHaveClass("sr-only");
    const tablist = within(dialog).getByRole("tablist", { name: "日历订阅管理视图" });
    const globalTab = within(tablist).getByRole("tab", { name: "全部续费" });
    const subscriptionsTab = within(tablist).getByRole("tab", { name: "单个订阅" });
    expect(globalTab).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).queryByRole("heading", { name: "全部续费" })).not.toBeInTheDocument();
    expect(within(dialog).getByText("同步有效订阅的未来续费和到期日期。")).toBeInTheDocument();
    expect(within(dialog).getAllByText("私有链接，请勿分享。")).toHaveLength(1);
    expect(within(dialog).getByLabelText("「全部续费」的日历订阅 URL")).toHaveValue(globalFeed.feedUrl);

    globalTab.focus();
    await user.keyboard("{ArrowRight}");
    expect(subscriptionsTab).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).queryByRole("heading", { name: "单个订阅" })).not.toBeInTheDocument();
    expect(within(dialog).getAllByText("私有链接，请勿分享。")).toHaveLength(1);
    const list = within(dialog).getByRole("list", { name: "单个订阅日历链接列表" });
    const row = within(list).getByRole("listitem");
    expect(row).toHaveTextContent(subscriptionFeed.subscription.name);
    expect(row).toHaveTextContent(/使用中 · /);
    expect(row).not.toHaveTextContent("状态：");
    const copy = within(row).getByRole("button", {
      name: `复制「${subscriptionFeed.subscription.name}」的日历订阅 URL`,
    });
    expect(copy).toHaveTextContent("复制");
    expect(copy).not.toHaveTextContent("复制 URL");
    expect(within(row).getByRole("button", {
      name: `在系统日历中打开「${subscriptionFeed.subscription.name}」`,
    })).toHaveTextContent("打开系统日历");

    await user.click(copy);
    expect(state.copyUrl).toHaveBeenCalledWith(subscriptionFeed.feedUrl, expect.any(HTMLInputElement));
    await user.click(within(dialog).getByRole("button", { name: "完成" }));
    await user.click(manage);
    expect(screen.getByRole("tab", { name: "单个订阅" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows only the next action for disabled and empty states", async () => {
    const user = userEvent.setup();
    const state = controller({
      global: { data: { enabled: false } },
      subscriptions: { data: { items: [], total: 0, hasMore: false } },
    });
    render(view(state));

    expect(screen.getByText("全部续费 · 未启用")).toBeInTheDocument();
    expect(screen.getByText("单个订阅 · 0 个")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "管理" }));
    const dialog = screen.getByRole("dialog", { name: "日历订阅" });
    expect(within(dialog).getByText("未启用")).toBeInTheDocument();
    expect(within(dialog).queryByText(/尚未生成/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText("私有链接，请勿分享。")).not.toBeInTheDocument();
    const generate = within(dialog).getByRole("button", { name: "生成全部续费日历订阅链接" });
    expect(generate).toHaveTextContent("生成链接");
    await user.click(generate);
    expect(state.create).toHaveBeenCalledWith({ scope: "all" });

    await user.click(within(dialog).getByRole("tab", { name: "单个订阅" }));
    expect(within(dialog).getByText("请从订阅的“添加到日历”中生成链接。")).toBeInTheDocument();
    expect(within(dialog).queryByText("私有链接，请勿分享。")).not.toBeInTheDocument();
  });

  it("keeps first-load failures independent and gives each view a retry", async () => {
    const user = userEvent.setup();
    const globalRetry = vi.fn().mockResolvedValue(undefined);
    const subscriptionsRetry = vi.fn().mockResolvedValue(undefined);
    render(view(controller({
      global: {
        data: undefined,
        error: new Error("global failed"),
        hasData: false,
        retry: globalRetry,
      },
      subscriptions: {
        data: undefined,
        error: new Error("subscriptions failed"),
        hasData: false,
        retry: subscriptionsRetry,
      },
    })));

    expect(screen.getByText("全部续费 · 状态未知")).toBeInTheDocument();
    expect(screen.getByText("单个订阅 · 暂不可用")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "管理" }));
    const dialog = screen.getByRole("dialog", { name: "日历订阅" });
    expect(within(within(dialog).getByRole("alert")).getByText("加载失败")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "生成全部续费日历订阅链接" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "重试" }));
    expect(globalRetry).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole("tab", { name: "单个订阅" }));
    expect(within(within(dialog).getByRole("alert")).getByText("加载失败")).toBeInTheDocument();
    expect(within(dialog).queryByRole("list")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "重试" }));
    expect(subscriptionsRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps stale values visible and marks both summaries as not updated", async () => {
    const user = userEvent.setup();
    render(view(controller({
      global: { error: new Error("refresh failed") },
      subscriptions: { error: new Error("refresh failed") },
    })));

    expect(screen.getByText("全部续费 · 已启用（未更新）")).toBeInTheDocument();
    expect(screen.getByText("单个订阅 · 1 个（未更新）")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "管理" }));
    const dialog = screen.getByRole("dialog", { name: "日历订阅" });
    expect(within(dialog).getByText("已启用 · 未更新")).toBeInTheDocument();
    expect(within(within(dialog).getByRole("alert")).getByText("未更新")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("「全部续费」的日历订阅 URL")).toHaveValue(globalFeed.feedUrl);

    await user.click(within(dialog).getByRole("tab", { name: "单个订阅" }));
    expect(within(within(dialog).getByRole("alert")).getByText("未更新")).toBeInTheDocument();
    expect(within(dialog).getByRole("listitem")).toHaveTextContent(subscriptionFeed.subscription.name);
  });

  it("labels the two loading states without collapsing them", async () => {
    const user = userEvent.setup();
    render(view(controller({
      global: { data: undefined, hasData: false, isInitialLoading: true },
      subscriptions: { data: undefined, hasData: false, isInitialLoading: true },
    })));

    expect(screen.getByText("全部续费 · 加载中")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在加载单个订阅摘要..." })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "管理" }));
    const dialog = screen.getByRole("dialog", { name: "日历订阅" });
    expect(within(dialog).getByRole("status", { name: "正在加载全部续费链接..." })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("tab", { name: "单个订阅" }));
    expect(within(dialog).getByRole("status", { name: "正在加载单个订阅链接..." })).toBeInTheDocument();
  });

  it("uses one confirmation dialog and isolates its pending state", async () => {
    const user = userEvent.setup();
    const initial = controller();
    const rendered = render(view(initial));
    await user.click(screen.getByRole("button", { name: "管理" }));
    await user.click(screen.getByRole("tab", { name: "单个订阅" }));
    const rotateTrigger = screen.getByRole("button", {
      name: `重新生成「${subscriptionFeed.subscription.name}」的日历订阅链接`,
    });
    expect(rotateTrigger).toHaveTextContent("重新生成");
    await user.click(rotateTrigger);

    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    const confirmation = screen.getByRole("alertdialog", {
      name: `重新生成「${subscriptionFeed.subscription.name}」的链接？`,
    });
    expect(within(confirmation).getByText("旧链接会立即失效，已添加的日历需要使用新链接重新订阅。")).toBeInTheDocument();
    await user.click(within(confirmation).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(rotateTrigger).toHaveFocus());

    await user.click(rotateTrigger);
    rendered.rerender(view(controller({
      pendingTargetKey: "subscription:sub-1",
      pendingKind: "rotate",
      subscriptions: {
        data: { items: [subscriptionFeed, secondSubscriptionFeed], total: 2, hasMore: false },
      },
    })));
    const pendingConfirmation = screen.getByRole("alertdialog");
    expect(within(pendingConfirmation).getByRole("button", { name: "重新生成中..." })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(within(pendingConfirmation).getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getAllByRole("button", { busy: true })).toHaveLength(1);
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("falls back to the subscriptions tab after revoking a row that unmounts", async () => {
    const user = userEvent.setup();
    let resolveRevoke: ((value: boolean) => void) | undefined;
    const revoke = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveRevoke = resolve;
    }));
    const rendered = render(view(controller({ revoke })));
    await user.click(screen.getByRole("button", { name: "管理" }));
    const subscriptionsTab = screen.getByRole("tab", { name: "单个订阅" });
    await user.click(subscriptionsTab);
    await user.click(screen.getByRole("button", {
      name: `撤销「${subscriptionFeed.subscription.name}」的日历订阅链接`,
    }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "撤销" }));

    rendered.rerender(view(controller({
      revoke,
      pendingTargetKey: "subscription:sub-1",
      pendingKind: "revoke",
      subscriptions: { data: { items: [], total: 0, hasMore: false } },
    })));
    await act(async () => resolveRevoke?.(true));

    await waitFor(() => expect(screen.getByRole("tab", { name: "单个订阅" })).toHaveFocus());
    expect(screen.getByText("请从订阅的“添加到日历”中生成链接。")).toBeInTheDocument();
  });

  it("focuses the generation action after the global feed is revoked", async () => {
    const user = userEvent.setup();
    let resolveRevoke: ((value: boolean) => void) | undefined;
    const revoke = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveRevoke = resolve;
    }));
    const rendered = render(view(controller({ revoke })));
    await user.click(screen.getByRole("button", { name: "管理" }));
    await user.click(screen.getByRole("button", { name: "撤销「全部续费」的日历订阅链接" }));
    const confirmation = screen.getByRole("alertdialog", { name: "撤销「全部续费」的链接？" });
    expect(within(confirmation).getByText("链接会立即失效，日历将停止同步。")).toBeInTheDocument();
    await user.click(within(confirmation).getByRole("button", { name: "撤销" }));

    rendered.rerender(view(controller({
      revoke,
      global: { data: { enabled: false } },
    })));
    await act(async () => resolveRevoke?.(true));

    await waitFor(() => expect(screen.getByRole("button", {
      name: "生成全部续费日历订阅链接",
    })).toHaveFocus());
  });
});
