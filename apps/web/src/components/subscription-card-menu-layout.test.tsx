import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assertDateOnly } from "@/lib/time/date-only";
import type { Subscription } from "@/types/subscription";
import { SubscriptionCard } from "./subscription-card";

const subscription: Subscription = {
  id: "sub-1",
  name: "Supabase Pro",
  logo: undefined,
  price: "25",
  currency: "USD",
  billingCycle: "monthly",
  customDays: undefined,
  customCycleUnit: undefined,
  oneTimeTermCount: undefined,
  oneTimeTermUnit: undefined,
  category: "hosting_domains",
  status: "active",
  paymentMethod: undefined,
  startDate: assertDateOnly("2026-01-14"),
  nextBillingDate: assertDateOnly("2026-02-14"),
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
};

function renderCard() {
  render(
    <TooltipProvider delayDuration={0}>
      <SubscriptionCard
        subscription={subscription}
        today="2026-05-18"
        inheritedReminderDays={5}
        categoryByValue={new Map([
          ["hosting_domains", {
            id: "hosting_domains",
            value: "hosting_domains",
            labels: { "zh-CN": "域名与托管", "en-US": "Domains & Hosting" },
            color: "hsl(32 86% 50%)",
          }],
        ])}
        paymentMethodByValue={new Map()}
        currencyConvert={(amount) => Number(amount)}
        currencyRatesReady={true}
        priceReferenceCurrency={null}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onTogglePublicHidden={vi.fn()}
      />
    </TooltipProvider>,
  );
}

function openMoreActionsMenu() {
  const menuButton = screen.getByRole("button", { name: "More actions" });
  fireEvent.pointerDown(menuButton, { button: 0, ctrlKey: false });
  fireEvent.click(menuButton);
}

describe("SubscriptionCard menu layout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-18T00:00:00.000Z"));
    Object.defineProperty(globalThis.navigator, "languages", { configurable: true, value: ["en-US"] });
    Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis.navigator, "languages", { configurable: true, value: ["zh-CN"] });
    Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "zh-CN" });
  });

  it("keeps long English action labels on one line", () => {
    renderCard();

    openMoreActionsMenu();

    expect(screen.getByRole("menu")).toHaveClass("w-max", "min-w-40");
    expect(screen.getAllByRole("menuitem", { name: "Hide from public page" })).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: "Hide from public page" })).toHaveClass("whitespace-nowrap");
  });
});
