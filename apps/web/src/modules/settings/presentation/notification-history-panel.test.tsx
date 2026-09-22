// 通知历史面板测试保护虚拟列表、详情展开和失败渠道展示，避免复杂 result union 被 UI 当成宽松对象。
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assertDateOnly } from "@/lib/time/date-only";
import { assertLocalTime } from "@/lib/time/local-time";
import { NotificationHistoryPanel } from "./notification-history-panel";
import type {
  NotificationHistoryResponse,
  NotificationOverviewResponse,
} from "@/lib/api/schemas/notifications";
import type { SettingsNotificationHistoryController } from "../application/use-notification-history";
import type { SettingsReadState } from "../application/settings-read-state";

interface TestNotificationData {
  overview: NotificationOverviewResponse;
  history: NotificationHistoryResponse;
}

function setElementOverflow(element: Element) {
  Object.defineProperties(element, {
    scrollWidth: { configurable: true, value: 420 },
    clientWidth: { configurable: true, value: 160 },
    scrollHeight: { configurable: true, value: 20 },
    clientHeight: { configurable: true, value: 20 },
  });
  fireEvent.resize(window);
}

function mockCompactHistoryLayout(matches = true) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 1023px)" ? matches : false,
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

function createHistoryResponse(reason: string): TestNotificationData {
  const job: NotificationHistoryResponse["jobs"][number] = {
    id: "job-1",
    scheduledLocalDate: assertDateOnly("2026-05-15"),
    scheduledLocalTime: assertLocalTime("06:33"),
    timeZone: "Asia/Shanghai",
    scheduledInstantUtc: "2026-05-14T22:33:00.000Z",
    status: "failed" as const,
    attempts: 2,
    lastError: reason,
    result: {
      source: "cron",
      reason,
      force: false,
      windowMinutes: 10,
      triggeredAtUtc: "2026-05-14T22:33:00.000Z",
      schedule: {
        scheduledLocalDate: assertDateOnly("2026-05-15"),
        scheduledLocalTime: assertLocalTime("06:33"),
        timeZone: "Asia/Shanghai",
        scheduledInstantUtc: "2026-05-14T22:33:00.000Z",
      },
      settings: {
        timezone: "Asia/Shanghai",
        locale: "zh-CN",
        notificationTimeLocal: assertLocalTime("06:33"),
        enabledChannels: ["email"],
        showExpired: false,
      },
      message: {
        title: "订阅提醒",
        content: "通知内容快照",
        timestamp: "2026-05-14T22:33:00.000Z",
        hasPayload: true,
        items: [{
          subscriptionId: "sub-1",
          name: "Very Long Service",
          type: "renewal",
          price: "10",
          currency: "USD",
          status: "active",
          targetDate: assertDateOnly("2026-05-15"),
          reminderDays: 3,
          daysUntil: 1,
        }],
      },
      channels: {
        attempted: ["email"],
        succeeded: ["telegram", "webhook"],
        failed: [{ channel: "email", error: reason }],
      },
    },
    createdAt: "2026-05-14T22:33:00.000Z",
    updatedAt: "2026-05-14T22:34:00.000Z",
  };

  return {
    overview: {
      summary: {
        nextCheck: {
          scheduledLocalDate: assertDateOnly("2026-05-16"),
          scheduledLocalTime: assertLocalTime("06:33"),
          timeZone: "Asia/Shanghai",
          scheduledInstantUtc: "2026-05-15T22:33:00.000Z",
        },
        nextContentBatch: null,
        blockers: ["no_upcoming_items"],
        enabledChannels: ["email"],
        upcomingDays: 30,
        latestJob: job,
        latestFailedJob: job,
      },
      upcoming: [],
    },
    history: {
      jobs: [job],
      status: "all",
      limit: 20,
      offset: 0,
      hasMore: false,
    },
  };
}

function createSkippedHistoryResponse(): TestNotificationData {
  const job: NotificationHistoryResponse["jobs"][number] = {
    id: "job-skipped",
    scheduledLocalDate: assertDateOnly("2026-05-17"),
    scheduledLocalTime: assertLocalTime("08:00"),
    timeZone: "UTC",
    scheduledInstantUtc: "2026-05-17T08:00:00Z",
    status: "skipped" as const,
    attempts: 1,
    lastError: null,
    result: {
      source: "cron",
      reason: "no_enabled_channels",
      force: false,
      windowMinutes: 2,
      triggeredAtUtc: "2026-05-17T08:00:00Z",
      schedule: {
        scheduledLocalDate: assertDateOnly("2026-05-17"),
        scheduledLocalTime: assertLocalTime("08:00"),
        timeZone: "UTC",
        scheduledInstantUtc: "2026-05-17T08:00:00Z",
      },
      settings: {
        timezone: "UTC",
        locale: "zh-CN",
        notificationTimeLocal: assertLocalTime("08:00"),
        enabledChannels: [],
        showExpired: true,
      },
      message: {
        title: "Renewlet 订阅提醒",
        content: "今天没有需要提醒的订阅。",
        timestamp: "2026-05-17 08:00:00 UTC",
        hasPayload: false,
        items: [],
      },
      channels: {
        attempted: [],
        succeeded: [],
        failed: [],
      },
    },
    createdAt: "2026-05-17T08:00:00Z",
    updatedAt: "2026-05-17T08:00:00Z",
  };

  return {
    overview: {
      summary: {
        nextCheck: {
          scheduledLocalDate: assertDateOnly("2026-05-18"),
          scheduledLocalTime: assertLocalTime("08:00"),
          timeZone: "UTC",
          scheduledInstantUtc: "2026-05-18T08:00:00Z",
        },
        nextContentBatch: null,
        blockers: ["no_enabled_channels"],
        enabledChannels: [],
        upcomingDays: 30,
        latestJob: job,
        latestFailedJob: null,
      },
      upcoming: [],
    },
    history: {
      jobs: [job],
      status: "all",
      limit: 20,
      offset: 0,
      hasMore: false,
    },
  };
}

function createUpcomingBatches(count: number): NotificationOverviewResponse["upcoming"] {
  return Array.from({ length: count }, (_, index) => {
    const day = String(1 + Math.floor(index / 24)).padStart(2, "0");
    const hour = String(index % 24).padStart(2, "0");
    return {
      scheduledLocalDate: assertDateOnly(`2026-05-${day}`),
      scheduledLocalTime: assertLocalTime(`${hour}:00`),
      timeZone: "Asia/Shanghai",
      scheduledInstantUtc: `2026-05-${day}T${hour}:00:00Z`,
      items: [{
        type: "renewal" as const,
        subscriptionId: `sub-${index}`,
        name: `Virtual Batch ${index}`,
        price: String(index + 1),
        currency: "USD",
        status: "active" as const,
        targetDate: assertDateOnly("2026-06-01"),
        reminderDays: 3,
        daysUntil: 3,
      }],
    };
  });
}

function readState<T>(data: T | undefined, overrides: Partial<SettingsReadState<T>> = {}): SettingsReadState<T> {
  return {
    data,
    hasData: data !== undefined,
    error: null,
    isInitialLoading: false,
    isRefreshing: false,
    retry: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createController(
  data: TestNotificationData,
  overrides: Partial<SettingsNotificationHistoryController> = {},
): SettingsNotificationHistoryController {
  return {
    overview: readState(data.overview),
    history: readState(data.history),
    historyStatus: "all",
    setStatus: vi.fn(),
    limit: 20,
    loadMore: vi.fn(),
    ...overrides,
  };
}

describe("NotificationHistoryPanel", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("limits an initial history failure and retry to the history tab", async () => {
    const user = userEvent.setup();
    const data = createSkippedHistoryResponse();
    const retry = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const controller = createController(data);
    controller.history = readState<NotificationHistoryResponse>(undefined, {
      error: new Error("history unavailable"),
      retry,
    });

    render(
      <TooltipProvider delayDuration={0}>
        <NotificationHistoryPanel controller={controller} />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "查看调度与历史" }));
    expect(screen.getByText("未来 30 天没有会自动发送的提醒。")).toBeInTheDocument();
    expect(screen.queryByText("加载失败")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "发送历史" }));
    expect(screen.getByText("加载失败")).toBeInTheDocument();
    expect(screen.queryByText("到达通知时间后，这里会显示调度记录。")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps cached history rows visible when refresh fails", async () => {
    const user = userEvent.setup();
    const data = createHistoryResponse("smtp: cached failure");
    const controller = createController(data);
    controller.history = readState(data.history, { error: new Error("refresh failed") });

    render(
      <TooltipProvider delayDuration={0}>
        <NotificationHistoryPanel controller={controller} />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "查看调度与历史" }));
    await user.click(screen.getByRole("tab", { name: "发送历史" }));
    expect(screen.getByText("未更新")).toBeInTheDocument();
    expect(screen.getAllByText("smtp: cached failure").length).toBeGreaterThan(0);
  });

  it("shows the next check time zone as a UTC offset", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <NotificationHistoryPanel
          controller={createController(createHistoryResponse("smtp: temporary failure"))}
        />
      </TooltipProvider>,
    );

    const nextCheck = screen.getByText("下一次检查").parentElement;

    expect(nextCheck).not.toBeNull();
    expect(within(nextCheck!).getByText("2026-05-16 06:33 (UTC+8)")).toBeInTheDocument();
    expect(within(nextCheck!).queryByText(/Asia\/Shanghai/)).not.toBeInTheDocument();
  });

  it("shows full history row text in a tooltip when truncated", async () => {
    const user = userEvent.setup();
    const reason = "smtp: 550 mailbox unavailable with a very long provider diagnostic message";

    render(
      <TooltipProvider delayDuration={0}>
        <NotificationHistoryPanel
          controller={createController(createHistoryResponse(reason))}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "查看调度与历史" }));
    await user.click(screen.getByRole("tab", { name: "发送历史" }));

    expect(screen.getByText("调度尝试 2 次")).toBeInTheDocument();
    expect(screen.getByText("累计尝试渠道")).toBeInTheDocument();
    expect(screen.getByText("累计成功渠道")).toBeInTheDocument();
    const detail = screen.getByTestId("notification-history-desktop-detail");
    expect(within(detail).getByText("邮件通知")).toBeInTheDocument();
    expect(within(detail).getByText("Telegram, Webhook 通知")).toBeInTheDocument();
    expect(within(detail).getByText(`邮件通知：${reason}`)).toBeInTheDocument();
    expect(detail).not.toHaveTextContent("email");

    let trigger: HTMLElement | undefined;
    await waitFor(() => {
      trigger = screen
        .getAllByText(reason)
        .find((element) => element.getAttribute("data-slot") === "truncated-tooltip-text");
      expect(trigger).toBeInTheDocument();
    });
    setElementOverflow(trigger!);
    await user.hover(trigger!);

    expect(await screen.findByRole("tooltip")).toHaveTextContent(reason);
  });

  it("uses a fixed dialog frame so tab changes only scroll the content viewport", async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider delayDuration={0}>
        <NotificationHistoryPanel
          controller={createController(createSkippedHistoryResponse())}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "查看调度与历史" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("flex", "min-h-0", "max-w-3xl", "overflow-hidden");
    expect(dialog.querySelector("[data-settings-manager-header]")).toHaveClass("shrink-0");
    expect(dialog.querySelector("[data-settings-manager-footer]")).toHaveClass("shrink-0");
    expect(screen.getByTestId("notification-history-scroll")).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
  });

  it("shows skipped empty-array history without a load failure", async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider delayDuration={0}>
        <NotificationHistoryPanel
          controller={createController(createSkippedHistoryResponse())}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "查看调度与历史" }));
    await user.click(screen.getByRole("tab", { name: "发送历史" }));

    expect(screen.queryByText("加载通知历史失败，请稍后重试。")).not.toBeInTheDocument();
    expect(screen.getAllByText("已跳过").length).toBeGreaterThan(0);
    expect(screen.getAllByText("0 项").length).toBeGreaterThan(0);
    expect(screen.getByText("累计尝试渠道")).toBeInTheDocument();
  });

  it("opens history details in a bounded mobile drawer instead of stacking them below the list", async () => {
    mockCompactHistoryLayout();
    const user = userEvent.setup();
    const reason = "smtp: 550 mailbox unavailable";

    render(
      <TooltipProvider delayDuration={0}>
        <NotificationHistoryPanel
          controller={createController(createHistoryResponse(reason))}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "查看调度与历史" }));
    await user.click(screen.getByRole("tab", { name: "发送历史" }));

    expect(screen.getByTestId("notification-history-desktop-detail")).toHaveClass("hidden", "lg:block");

    await user.click(screen.getAllByTestId("notification-history-row")[0]!);

    const drawer = await screen.findByTestId("notification-history-detail-drawer");
    expect(drawer).toHaveClass("h5-drawer-panel", "h5-notification-history-detail-drawer", "overflow-hidden");
    expect(within(drawer).getByText("发送详情")).toBeInTheDocument();
    expect(within(drawer).getByText("累计尝试渠道")).toBeInTheDocument();
    expect(within(drawer).getByText("邮件通知：smtp: 550 mailbox unavailable")).toBeInTheDocument();
    expect(drawer).not.toHaveTextContent("email");
  });

  it("labels upcoming repeat reminder items", async () => {
    const user = userEvent.setup();
    const data = createSkippedHistoryResponse();
    data.overview.upcoming = [{
      scheduledLocalDate: assertDateOnly("2026-05-16"),
      scheduledLocalTime: assertLocalTime("09:00"),
      timeZone: "UTC",
      scheduledInstantUtc: "2026-05-16T09:00:00Z",
      items: [{
        type: "renewal",
        subscriptionId: "sub-repeat",
        name: "Critical SaaS",
        price: "99",
        currency: "USD",
        status: "active",
        targetDate: assertDateOnly("2026-05-17"),
        reminderDays: 3,
        daysUntil: 1,
        repeatReminder: {
          interval: "1h",
          window: "72h",
        },
      }],
    }];

    render(
      <TooltipProvider delayDuration={0}>
        <NotificationHistoryPanel
          controller={createController(data)}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "查看调度与历史" }));

    expect(screen.getByText("Critical SaaS")).toBeInTheDocument();
    expect(screen.getByText("2026-05-17 · 重复提醒 1小时")).toBeInTheDocument();
  });

  it("labels upcoming cost sharing collection reminder items", async () => {
    const user = userEvent.setup();
    const data = createSkippedHistoryResponse();
    data.overview.upcoming = [{
      scheduledLocalDate: assertDateOnly("2026-05-16"),
      scheduledLocalTime: assertLocalTime("09:00"),
      timeZone: "UTC",
      scheduledInstantUtc: "2026-05-16T09:00:00Z",
      items: [{
        type: "costSharing",
        subscriptionId: "sub-family",
        name: "Family Plan",
        price: "30",
        currency: "USD",
        status: "active",
        targetDate: assertDateOnly("2026-05-17"),
        reminderDays: 1,
        daysUntil: 1,
        costSharing: {
          memberName: "Partner",
          amount: "10",
          currency: "USD",
        },
      }],
    }];

    render(
      <TooltipProvider delayDuration={0}>
        <NotificationHistoryPanel
          controller={createController(data)}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "查看调度与历史" }));

    expect(screen.getByText("Family Plan")).toBeInTheDocument();
    expect(screen.getByText("2026-05-17 · 向 Partner 收 $10 USD · 提前 1 天")).toBeInTheDocument();
  });

  it("virtualizes large upcoming schedule previews without changing history interactions", async () => {
    const user = userEvent.setup();
    const setStatus = vi.fn();
    const data = createSkippedHistoryResponse();
    data.overview.upcoming = createUpcomingBatches(40);

    render(
      <TooltipProvider delayDuration={0}>
        <NotificationHistoryPanel
          controller={createController(data, { setStatus })}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "查看调度与历史" }));

    expect(screen.getByTestId("virtualized-upcoming-notification-list")).toBeInTheDocument();
    expect(await screen.findByText("Virtual Batch 0")).toBeInTheDocument();
    expect(screen.getAllByText(/Virtual Batch/).length).toBeLessThan(40);
    expect(screen.queryByText("Virtual Batch 39")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "发送历史" }));
    await user.click(screen.getByRole("button", { name: "已跳过" }));

    expect(setStatus).toHaveBeenCalledWith("skipped");
    expect(screen.getByText("累计尝试渠道")).toBeInTheDocument();
  });
});
