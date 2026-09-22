import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assertDateOnly } from "@/lib/time/date-only";
import type { ConfigItem } from "@/types/config";
import type { Subscription } from "@/types/subscription";
import { moneyToNumber } from "@renewlet/shared/money";
import { SubscriptionCard } from "./subscription-card";

const category: ConfigItem = {
  id: "productivity",
  value: "productivity",
  labels: { "zh-CN": "生产力", "en-US": "Productivity" },
  color: "hsl(200 80% 50%)",
};

const subscription: Subscription = {
  id: "sub-1",
  name: "Shared SaaS",
  logo: undefined,
  price: "50",
  currency: "CNY",
  billingCycle: "monthly",
  customDays: undefined,
  customCycleUnit: undefined,
  oneTimeTermCount: undefined,
  oneTimeTermUnit: undefined,
  category: "productivity",
  status: "active",
  paymentMethod: undefined,
  startDate: assertDateOnly("2026-05-15"),
  nextBillingDate: assertDateOnly("2026-06-15"),
  autoRenew: false,
  autoCalculateNextBillingDate: true,
  trialEndDate: undefined,
  website: undefined,
  notes: undefined,
  tags: [],
  reminderDays: 7,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  extra: {},
  pinned: false,
  publicHidden: false,
  costSharing: {
    enabled: true,
    splitMode: "custom",
    members: [
      { id: "eur", name: "EUR member", currency: "EUR", customAmount: "10" },
      { id: "usd", name: "USD member", currency: "USD", customAmount: "10" },
    ],
  },
};

describe("SubscriptionCard cost sharing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
  });

  it("renders the current user's share in the subscription currency", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionCard
          subscription={subscription}
          today="2026-05-18"
          categoryByValue={new Map([[category.value, category]])}
          paymentMethodByValue={new Map()}
          currencyRatesReady={true}
          currencyConvert={(amount, from, to) => {
            const value = moneyToNumber(amount);
            if (to !== "CNY") return value;
            if (from === "EUR") return value * 8;
            if (from === "USD") return value * 7;
            return value;
          }}
          priceReferenceCurrency={null}
        />
      </TooltipProvider>,
    );

    expect(screen.getByText(/你的份额\s*¥0 CNY/)).toBeInTheDocument();
    expect(screen.getByText("日均 ¥1.67")).toBeInTheDocument();
  });
});
