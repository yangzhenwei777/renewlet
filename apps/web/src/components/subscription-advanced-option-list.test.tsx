import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AdvancedOptionList } from "@/components/subscription-advanced-option-list";

function optionRow(checkbox: HTMLElement): HTMLElement {
  const row = checkbox.closest("[data-advanced-option-row]");
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe("AdvancedOptionList", () => {
  it("keeps options in one lightweight checkbox list and toggles with keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <AdvancedOptionList
        options={[
          { value: "card", label: "Credit card" },
          { value: "paypal", label: "PayPal" },
          { value: "bank", label: "Bank transfer" },
        ]}
        selectedValues={["paypal"]}
        onChange={onChange}
        layout="desktop"
        searchPlaceholder="Filter payment methods"
        emptyMessage="No payment methods"
        searchResultsLabel="Search results"
        allOptionsLabel="All payment methods"
        testId="advanced-option-list"
      />,
    );

    const list = screen.getByTestId("advanced-option-list-all-options");
    const checkboxes = within(list).getAllByRole("checkbox");
    expect(checkboxes.map((checkbox) => checkbox.getAttribute("aria-label"))).toEqual([
      "Credit card",
      "PayPal",
      "Bank transfer",
    ]);
    expect(screen.queryByTestId("advanced-option-list-selected-options")).not.toBeInTheDocument();

    const paypal = within(list).getByRole("checkbox", { name: "PayPal" });
    expect(paypal).toHaveAttribute("aria-checked", "true");
    expect(optionRow(paypal)).toHaveClass("border-primary/60", "bg-primary/5");
    expect(optionRow(paypal)).not.toHaveClass("bg-primary/10");

    await user.tab();
    expect(checkboxes[0]).toHaveFocus();
    await user.keyboard("[Space]");

    expect(onChange).toHaveBeenLastCalledWith(["paypal", "card"]);

    await user.click(screen.getByText("Bank transfer"));
    expect(onChange).toHaveBeenLastCalledWith(["paypal", "bank"]);
  });
});
