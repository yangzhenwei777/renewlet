import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import type { RecurringCycleSubscription } from "@/types/subscription";
import { UpcomingRenewals } from "./upcoming-renewals";

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    locale: "zh-CN",
    t: (key: string, params?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        "upcoming.noneNextTwoWeeks": "暂无进入提醒窗口的续费或到期",
        "upcoming.todayShort": "今",
        "upcoming.daysShort": "{days}天",
        "upcoming.renewsOn": "{date} 续费",
        "upcoming.expiresOn": "{date} 到期",
      };
      let value = messages[key] ?? key;
      for (const [name, replacement] of Object.entries(params ?? {})) {
        value = value.replace(`{${name}}`, String(replacement));
      }
      return value;
    },
    formatCurrency: (amount: number, currency: string) => `${currency} ${amount}`,
  }),
}));

const baseSubscription: RecurringCycleSubscription = {
  id: "netflix",
  name: "Netflix",
  logo: undefined,
  price: "10",
  currency: "USD",
  billingCycle: "annual",
  customDays: undefined,
  customCycleUnit: undefined,
  oneTimeTermCount: undefined,
  oneTimeTermUnit: undefined,
  category: "entertainment",
  status: "active",
  paymentMethod: undefined,
  startDate: assertDateOnly("2025-07-15"),
  nextBillingDate: assertDateOnly("2026-07-15"),
  autoRenew: false,
  autoCalculateNextBillingDate: true,
  trialEndDate: undefined,
  website: undefined,
  notes: undefined,
  tags: [],
  reminderDays: 30,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  extra: {},
  pinned: false,
  publicHidden: false,
};

function subscription(overrides: Partial<RecurringCycleSubscription> = {}): RecurringCycleSubscription {
  return { ...baseSubscription, ...overrides };
}

describe("UpcomingRenewals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows subscriptions inside their effective reminder window", () => {
    render(
      <UpcomingRenewals
        subscriptions={[subscription()]}
        today="2026-06-15"
        notificationReminderDays={3}
      />,
    );

    expect(screen.getByText("Netflix")).toBeInTheDocument();
    expect(screen.getByText("30天")).toBeInTheDocument();
    expect(screen.getByText("USD 10")).toBeInTheDocument();
  });

  it("shares compact columns while only the subscription name can shrink and wrap", () => {
    render(
      <UpcomingRenewals
        subscriptions={[subscription({ name: "AnExtremelyLongSubscriptionNameWithoutNaturalBreaks" })]}
        today="2026-06-15"
        notificationReminderDays={3}
      />,
    );

    const name = screen.getByText("AnExtremelyLongSubscriptionNameWithoutNaturalBreaks");
    const details = name.parentElement;
    const row = details?.parentElement;
    const list = row?.parentElement;
    if (!details || !row || !list) {
      throw new Error("Expected the upcoming renewal content to render inside its shared grid row.");
    }

    const price = screen.getByText("USD 10");
    expect(list).toHaveClass("grid", "min-w-0", "grid-cols-[max-content_minmax(0,1fr)_max-content]");
    expect(row).toHaveClass("col-span-3", "grid", "min-w-0", "grid-cols-subgrid");
    expect(row.children[1]).toBe(details);
    expect(row.children[2]).toBe(price);
    expect(details).toHaveClass("min-w-0");
    expect(name).toHaveClass("min-w-0", "wrap-break-word");
    expect(price).toHaveClass("whitespace-nowrap", "text-right", "tabular-nums");
  });

  it("uses the reminder-window empty state instead of the old two-week copy", () => {
    render(
      <UpcomingRenewals
        subscriptions={[subscription({ reminderDays: 14 })]}
        today="2026-06-15"
        notificationReminderDays={3}
      />,
    );

    expect(screen.getByText("暂无进入提醒窗口的续费或到期")).toBeInTheDocument();
    expect(screen.queryByText("未来两周内无续费或到期")).not.toBeInTheDocument();
  });
});
