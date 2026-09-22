import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FormField, FormFieldRow, FormFieldRowAction } from "./form-field";

describe("FormField", () => {
  it("connects description and field errors without rendering empty error slots", () => {
    const { rerender } = render(
      <FormField id="amount" label="Amount" description="Monthly amount">
        {(field) => (
          <input
            id={field.id}
            aria-invalid={field.invalid}
            aria-describedby={field.describedBy}
          />
        )}
      </FormField>,
    );

    const input = screen.getByLabelText("Amount");
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(input).toHaveAttribute("aria-describedby", "amount-description");
    expect(screen.queryByRole("alert")).toBeNull();

    rerender(
      <FormField id="amount" label="Amount" description="Monthly amount" error="Enter an amount">
        {(field) => (
          <input
            id={field.id}
            aria-invalid={field.invalid}
            aria-describedby={field.describedBy}
          />
        )}
      </FormField>,
    );

    expect(screen.getByLabelText("Amount")).toHaveAttribute(
      "aria-describedby",
      "amount-description amount-error",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an amount");
  });
});

describe("FormFieldRow", () => {
  it("uses two shared tracks when the row has no descriptions", () => {
    const { container } = render(
      <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2">
        <FormField id="price" label="Price">{(field) => <input id={field.id} />}</FormField>
        <FormField id="currency" label="Currency">{(field) => <input id={field.id} />}</FormField>
      </FormFieldRow>,
    );

    const row = container.querySelector('[data-slot="form-field-row"]');
    expect(row).toHaveAttribute("data-align-at", "sm");
    expect(row).toHaveAttribute("data-tracks", "2");
    expect(container.querySelectorAll('[data-slot="form-field"]')).toHaveLength(2);
    expect(container.querySelector('[data-slot="form-field"]')).toHaveClass("sm:row-span-2", "sm:grid-rows-subgrid");
  });

  it("uses three shared tracks only when a description exists", () => {
    const { container, rerender } = render(
      <FormFieldRow alignAt="md" rowClassName="md:grid-cols-2">
        <FormField id="name" label="Name">{(field) => <input id={field.id} />}</FormField>
        <FormField id="password" label="Password" description="Use your current password">
          {(field) => <input id={field.id} aria-describedby={field.describedBy} />}
        </FormField>
      </FormFieldRow>,
    );

    expect(container.querySelector('[data-slot="form-field-row"]')).toHaveAttribute("data-tracks", "3");
    expect(container.querySelector('[data-slot="form-field"]')).toHaveClass("md:row-span-3", "md:grid-rows-subgrid");
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-describedby", "password-description");

    rerender(
      <FormFieldRow alignAt="md" rowClassName="md:grid-cols-2">
        <FormField id="name" label="Name">{(field) => <input id={field.id} />}</FormField>
        <FormField id="password" label="Password">{(field) => <input id={field.id} />}</FormField>
      </FormFieldRow>,
    );
    expect(container.querySelector('[data-slot="form-field-row"]')).toHaveAttribute("data-tracks", "2");
    expect(container.querySelector('[data-slot="form-field-description"]')).toBeNull();
  });

  it("renders row errors outside shared tracks and preserves field aria ownership", () => {
    const { rerender } = render(
      <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2" errors={[{ id: "price-error" }]}>
        <FormField id="price" label="Price" renderError={false}>
          {(field) => <input id={field.id} aria-describedby={field.describedBy} />}
        </FormField>
        <FormField id="currency" label="Currency" renderError={false}>
          {(field) => <input id={field.id} />}
        </FormField>
      </FormFieldRow>,
    );

    expect(screen.queryByRole("alert")).toBeNull();

    rerender(
      <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2" errors={[{ id: "price-error", message: "Enter a price" }]}>
        <FormField id="price" label="Price" error="Enter a price" renderError={false}>
          {(field) => <input id={field.id} aria-describedby={field.describedBy} />}
        </FormField>
        <FormField id="currency" label="Currency" renderError={false}>
          {(field) => <input id={field.id} />}
        </FormField>
      </FormFieldRow>,
    );

    expect(screen.getByRole("alert")).toHaveAttribute("id", "price-error");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a price");
    expect(screen.getByLabelText("Price")).toHaveAttribute("aria-describedby", "price-error");
    expect(screen.getByRole("alert").parentElement).toHaveAttribute("data-slot", "form-field-row-errors");
  });

  it("keeps the action after fields in mobile DOM order and aligns it to the desktop control track", () => {
    const { container } = render(
      <FormFieldRow alignAt="lg" rowClassName="lg:grid-cols-[1fr_1fr_auto]">
        <FormField id="name" label="Name">{(field) => <input id={field.id} />}</FormField>
        <FormField id="password" label="Password" description="Required">
          {(field) => <input id={field.id} />}
        </FormField>
        <FormFieldRowAction><button type="button">Add</button></FormFieldRowAction>
      </FormFieldRow>,
    );

    const layout = container.querySelector('[data-slot="form-field-row"] > div');
    expect(layout?.children).toHaveLength(3);
    expect(layout?.children[0]).toHaveAttribute("data-slot", "form-field");
    expect(layout?.children[1]).toHaveAttribute("data-slot", "form-field");
    expect(layout?.children[2]).toHaveAttribute("data-slot", "form-field-row-action");
    expect(layout?.children[2]).toHaveClass("lg:row-span-3", "lg:grid-rows-subgrid");
    expect(layout?.children[2]?.querySelector('[data-slot="form-field-row-action-control"]')).toHaveClass("self-start");
  });
});
