import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AddSubscriptionDialog } from "./add-subscription-dialog";

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        "subscription.add": "添加订阅",
      };
      return messages[key] ?? key;
    },
  }),
}));

vi.mock("@/components/subscription-dialog", () => ({
  SubscriptionDialog: ({
    open,
    onOpenChange,
    trigger,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    trigger?: ReactNode;
  }) => (
    <div onClickCapture={() => onOpenChange(true)}>
      {trigger}
      <span data-testid="add-subscription-dialog-open">{String(open)}</span>
    </div>
  ),
}));

describe("AddSubscriptionDialog trigger", () => {
  it("keeps the default add shortcut compact on mobile and opens the create dialog", async () => {
    const user = userEvent.setup();

    render(<AddSubscriptionDialog onAdd={vi.fn()} />);

    const button = screen.getByRole("button", { name: /添加订阅/ });
    expect(button).toHaveClass("h-12", "w-12", "px-0", "sm:h-10", "sm:w-10", "sm:px-0", "xl:w-auto", "xl:px-4");
    const visibleLabel = Array.from(button.querySelectorAll("span")).find((span) => span.className.includes("xl:inline"));
    if (!visibleLabel) throw new Error("Expected the desktop add shortcut label to appear only at xl and above.");
    expect(visibleLabel).toHaveClass("hidden", "xl:inline");
    const screenReaderLabel = button.querySelector<HTMLElement>("span.sr-only");
    if (!screenReaderLabel) throw new Error("Expected the mobile add shortcut to keep a screen-reader label.");
    expect(screenReaderLabel).toHaveClass("sr-only", "xl:hidden");
    expect(screen.getByTestId("add-subscription-dialog-open")).toHaveTextContent("false");

    await user.click(button);

    expect(screen.getByTestId("add-subscription-dialog-open")).toHaveTextContent("true");
  });
});
