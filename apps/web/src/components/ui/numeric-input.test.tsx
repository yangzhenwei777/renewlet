// NumericInput 测试保护金额输入的格式化和原始字符串回传，避免浏览器宽松数字解析污染表单校验。
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NumericInput, type NumericInputProps } from "./numeric-input";

function ControlledNumericInput({
  onRawValue,
  ...props
}: Omit<NumericInputProps, "onRawValueChange" | "value"> & {
  onRawValue: (value: string) => void;
}) {
  const [value, setValue] = useState("");

  return (
    <NumericInput
      {...props}
      value={value}
      onRawValueChange={(nextValue) => {
        onRawValue(nextValue);
        setValue(nextValue);
      }}
    />
  );
}

describe("NumericInput", () => {
  it("renders as a text input and emits unformatted decimal values", async () => {
    const user = userEvent.setup();
    const rawValues: string[] = [];

    render(
      <ControlledNumericInput
        aria-label="Amount"
        allowNegative={false}
        inputMode="decimal"
        onRawValue={(value) => rawValues.push(value)}
        thousandSeparator
      />,
    );

    const input = screen.getByLabelText("Amount");
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("inputmode", "decimal");
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();

    await user.type(input, "1234.56");

    expect(input).toHaveValue("1,234.56");
    expect(rawValues[rawValues.length - 1]).toBe("1234.56");
  });

  it("keeps negative signs and exponent notation out of the raw value", async () => {
    const user = userEvent.setup();
    const rawValues: string[] = [];

    render(
      <ControlledNumericInput
        aria-label="Amount"
        allowNegative={false}
        onRawValue={(value) => rawValues.push(value)}
      />,
    );

    const input = screen.getByLabelText("Amount") as HTMLInputElement;
    await user.type(input, "-1e3");

    expect(input.value).not.toContain("-");
    expect(input.value).not.toContain("e");
    expect(rawValues.every((value) => !/[eE-]/.test(value))).toBe(true);
  });

  it("keeps integer inputs free of decimal separators", async () => {
    const user = userEvent.setup();
    const rawValues: string[] = [];

    render(
      <ControlledNumericInput
        aria-label="Days"
        allowNegative={false}
        decimalScale={0}
        inputMode="numeric"
        onRawValue={(value) => rawValues.push(value)}
      />,
    );

    const input = screen.getByLabelText("Days") as HTMLInputElement;
    expect(input).toHaveAttribute("inputmode", "numeric");

    await user.type(input, "12.5");

    expect(input.value).not.toContain(".");
    expect(rawValues.every((value) => !value.includes("."))).toBe(true);
  });

  it("keeps bounded integer inputs within range while allowing empty edits", async () => {
    const user = userEvent.setup();
    const rawValues: string[] = [];

    render(
      <ControlledNumericInput
        aria-label="Retention"
        allowNegative={false}
        decimalScale={0}
        inputMode="numeric"
        isAllowed={(values) => (
          values.value === ""
          || (values.floatValue !== undefined && values.floatValue >= 1 && values.floatValue <= 30)
        )}
        onRawValue={(value) => rawValues.push(value)}
      />,
    );

    const input = screen.getByLabelText("Retention") as HTMLInputElement;

    await user.type(input, "30");
    expect(input).toHaveValue("30");
    expect(rawValues[rawValues.length - 1]).toBe("30");

    await user.clear(input);
    expect(input).toHaveValue("");
    expect(rawValues[rawValues.length - 1]).toBe("");

    await user.type(input, "0");
    expect(input).toHaveValue("");
    expect(rawValues[rawValues.length - 1]).toBe("");

    await user.type(input, "31");
    expect(input).toHaveValue("3");
    expect(rawValues[rawValues.length - 1]).toBe("3");
  });
});
