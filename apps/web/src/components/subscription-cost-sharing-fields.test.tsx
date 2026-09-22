import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CostSharingFields, CostSharingMemberManagerView } from "./subscription-cost-sharing-fields";
import { assertDateOnly } from "@/lib/time/date-only";
import { createSubscriptionFormState, type SubscriptionFormState } from "@/types/subscription-form";
import type { CostSharing } from "@/types/subscription";
import type { SearchableSelectOption } from "@/lib/searchable-options";

const currencyOptions: SearchableSelectOption[] = [
  { value: "CNY", label: "人民币" },
  { value: "USD", label: "美元" },
];

const costSharing: CostSharing = {
  enabled: true,
  splitMode: "custom",
  members: [
    { id: "partner", name: "伴侣", currency: "CNY", customAmount: "50" },
    { id: "friend", name: "朋友", currency: "CNY", customAmount: "30" },
  ],
};

function CostSharingHarness({
  initialCostSharing = costSharing,
  price = "50",
  currency = "CNY",
  collectionReminderAllowed = true,
  error,
  formOverrides,
}: {
  initialCostSharing?: CostSharing;
  price?: string;
  currency?: string;
  collectionReminderAllowed?: boolean;
  error?: string | undefined;
  formOverrides?: Partial<SubscriptionFormState> | undefined;
} = {}) {
  const [formData, setFormData] = useState(() => createSubscriptionFormState({
    price,
    currency,
    costSharing: initialCostSharing,
    ...formOverrides,
  }));
  const update = <K extends keyof SubscriptionFormState>(key: K, value: SubscriptionFormState[K]) => {
    setFormData((current) => ({ ...current, [key]: value }));
  };

  return (
    <div>
      <CostSharingFields
        id={(name) => name}
        formData={formData}
        update={update}
        currencyOptions={currencyOptions}
        notificationReminderDays={5}
        collectionReminderAllowed={collectionReminderAllowed}
        error={error}
      />
      <CostSharingMemberManagerView
        id={(name) => name}
        formData={formData}
        update={update}
        currencyOptions={currencyOptions}
        notificationReminderDays={5}
        collectionReminderAllowed={collectionReminderAllowed}
        error={error}
      />
    </div>
  );
}

describe("Subscription cost sharing fields", () => {
  it("treats members as other people and custom amounts as recoverable money", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <CostSharingHarness />
      </TooltipProvider>,
    );

    expect(screen.queryByRole("button", { name: "设为我" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "设为付款人" })).not.toBeInTheDocument();
    expect(screen.queryByText("付款人")).not.toBeInTheDocument();
    expect(screen.getByTestId("cost-sharing-summary")).toHaveTextContent(/成员合计\s*¥80 CNY/);
    expect(screen.getByTestId("cost-sharing-summary")).toHaveTextContent(/你的份额\s*¥0 CNY/);
    expect(screen.getByTestId("cost-sharing-summary")).toHaveTextContent(/可回收金额\s*¥80 CNY/);
    expect(screen.getByTestId("cost-sharing-custom-total-hint")).toHaveTextContent("成员金额是你希望回收的金额");

    const amountInputs = screen.getAllByLabelText("应收金额");
    await user.clear(amountInputs[1]!);
    await user.type(amountInputs[1]!, "10");

    expect(screen.getByTestId("cost-sharing-summary")).toHaveTextContent(/成员合计\s*¥60 CNY/);
    expect(screen.getByTestId("cost-sharing-summary")).toHaveTextContent(/你的份额\s*¥0 CNY/);
    expect(screen.getByTestId("cost-sharing-summary")).toHaveTextContent(/可回收金额\s*¥60 CNY/);
  });

  it("keeps collection reminder configuration in the member manager and summarizes it on the main form", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <CostSharingHarness formOverrides={{ billingCycle: "quarterly" }} />
      </TooltipProvider>,
    );

    const reminderSwitch = screen.getByRole("switch", { name: "收款提醒" });
    expect(reminderSwitch).not.toBeChecked();
    expect(screen.getByTestId("cost-sharing-collection-reminder-summary")).toHaveTextContent("收款提醒：关闭");

    await user.click(reminderSwitch);
    expect(reminderSwitch).toBeChecked();
    expect(screen.getByTestId("cost-sharing-collection-reminder-summary")).toHaveTextContent("收款提醒：跟随扣费周期：每季 · 按成员上车日期 · 提前 5 天");
    expect(screen.queryByRole("combobox", { name: "收款周期" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "提前" })).toHaveTextContent("默认值从设置中获取");

    await user.click(screen.getByRole("combobox", { name: "提前" }));
    await user.click(await screen.findByText("自定义天数"));
    const customDays = screen.getByPlaceholderText("天数");
    expect(customDays).toHaveValue("2");

    await user.clear(customDays);
    await user.type(customDays, "9");
    expect(customDays).toHaveValue("9");
    expect(screen.getByTestId("cost-sharing-collection-reminder-summary")).toHaveTextContent("收款提醒：跟随扣费周期：每季 · 按成员上车日期 · 提前 9 天");
    expect(screen.queryByPlaceholderText("月数")).not.toBeInTheDocument();
  });

  it("edits per-member joined dates with the shared date picker instead of a native date input", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <CostSharingHarness
          initialCostSharing={{
            ...costSharing,
            members: [
              { ...costSharing.members[0]!, joinedDate: assertDateOnly("2026-01-01") },
              costSharing.members[1]!,
            ],
          }}
        />
      </TooltipProvider>,
    );

    const manager = screen.getByTestId("cost-sharing-members-view");
    expect(manager.querySelector('input[type="date"]')).toBeNull();
    const memberName = within(manager).getAllByLabelText("成员名称")[0]!;
    const memberNote = within(manager).getAllByLabelText("成员备注")[0]!;
    const memberRow = memberName.closest('[data-slot="form-field-row"]');
    expect(memberRow).toHaveAttribute("data-align-at", "md");
    expect(memberRow).toHaveAttribute("data-tracks", "2");
    expect(memberNote.closest('[data-slot="form-field"]')).toBe(memberName.closest('[data-slot="form-field"]'));
    expect(memberRow?.querySelector('[data-slot="form-field-row-action"]')).toContainElement(
      within(memberRow as HTMLElement).getByRole("button", { name: "删除" }),
    );
    const joinedDateButtons = within(manager).getAllByRole("button", { name: /上车日期/ });
    expect(joinedDateButtons).toHaveLength(2);
    expect(joinedDateButtons[0]).toHaveTextContent("2026年1月1日");

    await user.click(joinedDateButtons[0]!);
    await user.click(await screen.findByRole("button", { name: /2026年1月15日/ }));

    expect(within(manager).getAllByRole("button", { name: /上车日期/ })[0]).toHaveTextContent("2026年1月15日");
  });

  it("marks missing member joined dates when collection reminders need a member anchor", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <CostSharingHarness
          error="请选择成员上车日期"
          initialCostSharing={{
            enabled: true,
            splitMode: "equal",
            collectionReminder: { enabled: true, reminderDays: -1 },
            members: [{ id: "partner", name: "Partner", currency: "USD" }],
          }}
          formOverrides={{ startDate: undefined }}
        />
      </TooltipProvider>,
    );

    const manager = screen.getByTestId("cost-sharing-members-view");
    const joinedDateButton = within(manager).getByRole("button", { name: /上车日期.*选择日期/ });
    expect(joinedDateButton).toHaveAttribute("aria-invalid", "true");
    expect(joinedDateButton).toHaveAttribute("aria-describedby", "costSharingMembers-error");
    expect(within(manager).getByText("请选择成员上车日期")).toBeInTheDocument();
  });

  it("does not render an independent collection cycle control", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <CostSharingHarness
          initialCostSharing={{
            enabled: true,
            splitMode: "equal",
            collectionReminder: { enabled: true, reminderDays: -1 },
            members: [{ id: "partner", name: "Partner", currency: "USD", joinedDate: assertDateOnly("2026-01-01") }],
          }}
        />
      </TooltipProvider>,
    );

    const manager = screen.getByTestId("cost-sharing-members-view");
    expect(within(manager).queryByLabelText("收款周期")).not.toBeInTheDocument();
    expect(within(manager).getByText(/跟随扣费周期/)).toBeInTheDocument();
  });

  it("disables collection reminders for one-time buyout flows", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <CostSharingHarness collectionReminderAllowed={false} />
      </TooltipProvider>,
    );

    expect(screen.getByTestId("cost-sharing-collection-reminder-summary")).toHaveTextContent("收款提醒：买断不提醒");
    expect(screen.getByRole("switch", { name: "收款提醒" })).toBeDisabled();
  });

  it("shows equal split member amount without ellipsis while currency code stays in the adjacent selector", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <CostSharingHarness
          price="100"
          currency="USD"
          initialCostSharing={{
            enabled: true,
            splitMode: "equal",
            members: [{ id: "partner", name: "Partner", currency: "USD" }],
          }}
        />
      </TooltipProvider>,
    );

    const amount = screen.getByText("$50");
    expect(amount).toHaveClass("break-all");
    expect(amount).not.toHaveClass("overflow-hidden", "text-ellipsis", "whitespace-nowrap");
    expect(screen.getAllByText("USD").length).toBeGreaterThan(0);
  });
});
