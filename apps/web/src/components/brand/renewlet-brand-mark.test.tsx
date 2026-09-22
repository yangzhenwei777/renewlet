import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { RenewletBrandLockup, RenewletBrandMark } from "./renewlet-brand-mark";

describe("RenewletBrandMark", () => {
  it("keeps brand mark sizes on the shared component contract", () => {
    const { rerender } = render(<RenewletBrandMark data-testid="brand-mark" size="sm" />);

    expect(screen.getByTestId("brand-mark")).toHaveClass("h-10", "w-10", "rounded-xl");
    expect(screen.getByTestId("brand-mark").querySelector("svg")).toHaveClass("h-5", "w-5");

    rerender(<RenewletBrandMark data-testid="brand-mark" size="md" />);
    expect(screen.getByTestId("brand-mark")).toHaveClass("h-12", "w-12", "rounded-xl");
    expect(screen.getByTestId("brand-mark").querySelector("svg")).toHaveClass("h-6", "w-6");

    rerender(<RenewletBrandMark data-testid="brand-mark" size="lg" />);
    expect(screen.getByTestId("brand-mark")).toHaveClass("h-14", "w-14", "rounded-2xl");
    expect(screen.getByTestId("brand-mark").querySelector("svg")).toHaveClass("h-7", "w-7");
  });

  it("centralizes brand colors and focus ring for interactive marks", () => {
    render(
      <MemoryRouter>
        <RenewletBrandMark href="/" />
      </MemoryRouter>,
    );

    const mark = screen.getByRole("link", { name: "Renewlet" });
    expect(mark).toHaveClass(
      "bg-brand-mark",
      "text-brand-mark-foreground",
      "ring-white/10",
      "focus-visible:ring-2",
      "focus-visible:ring-ring",
      "focus-visible:ring-offset-background",
    );
    expect(mark.className).not.toContain("bg-[");
    expect(mark.className).not.toContain("text-[");
  });
});

describe("RenewletBrandLockup", () => {
  it("keeps the mark decorative while exposing the visible title", () => {
    render(<RenewletBrandLockup title="Renewlet" subtitle="Subscription manager" />);

    expect(screen.getByRole("heading", { name: "Renewlet" })).toHaveClass("truncate");
    expect(screen.getByText("Subscription manager")).toHaveClass("truncate", "text-muted-foreground");
    expect(screen.getByText("Renewlet").closest("div")?.previousElementSibling).toHaveAttribute("aria-hidden", "true");
  });

  it("accepts explicit undefined class props under exact optional property types", () => {
    const optionalClassName: string | undefined = undefined;

    render(
      <RenewletBrandLockup
        title="Renewlet"
        subtitle={undefined}
        className={optionalClassName}
        markClassName={optionalClassName}
        textClassName={optionalClassName}
        titleClassName={optionalClassName}
        subtitleClassName={optionalClassName}
      />,
    );

    expect(screen.getByRole("heading", { name: "Renewlet" })).toBeInTheDocument();
  });
});
