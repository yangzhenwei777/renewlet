// 订阅卡片复制测试专注菜单事件边界，避免主卡片测试文件继续膨胀。
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assertDateOnly } from "@/lib/time/date-only";
import type { Subscription } from "@/types/subscription";
import { SubscriptionCard } from "./subscription-card";

const subscription: Subscription = {
  id: "sub-1",
  name: "Fastmail",
  logo: undefined,
  price: "5",
  currency: "USD",
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
};

function renderCard(onClone = vi.fn(), onViewDetails = vi.fn()) {
  render(
    <TooltipProvider delayDuration={0}>
      <SubscriptionCard
        subscription={subscription}
        today="2026-05-18"
        inheritedReminderDays={5}
        categoryByValue={new Map([
          ["productivity", {
            id: "productivity",
            value: "productivity",
            labels: { "zh-CN": "生产力", "en-US": "Productivity" },
            color: "hsl(200 80% 50%)",
          }],
        ])}
        paymentMethodByValue={new Map()}
        currencyConvert={(amount) => Number(amount)}
        currencyRatesReady={true}
        priceReferenceCurrency={null}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={onClone}
        onViewDetails={onViewDetails}
      />
    </TooltipProvider>,
  );
}

function openMoreActionsMenu() {
  const menuButton = screen.getByRole("button", { name: "更多操作" });
  fireEvent.pointerDown(menuButton, { button: 0, ctrlKey: false });
  fireEvent.click(menuButton);
}

describe("SubscriptionCard clone action", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clones subscriptions from the card menu without opening details", () => {
    const onClone = vi.fn();
    const onViewDetails = vi.fn();
    renderCard(onClone, onViewDetails);

    openMoreActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "复制" }));

    expect(onClone).toHaveBeenCalledWith("sub-1");
    expect(onViewDetails).not.toHaveBeenCalled();
  });
});
