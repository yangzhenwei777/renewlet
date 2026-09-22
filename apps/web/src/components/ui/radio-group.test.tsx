// RadioGroup 原语测试保护表单单选语义，避免设置项退回 aria-pressed 按钮组。
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { RadioGroup, RadioGroupItem } from "./radio-group";

function RadioGroupHarness() {
  const [value, setValue] = useState("plain");

  return (
    <RadioGroup value={value} onValueChange={setValue} aria-label="消息样式">
      <label htmlFor="format-plain">
        <RadioGroupItem id="format-plain" value="plain" />
        纯文本
      </label>
      <label htmlFor="format-html">
        <RadioGroupItem id="format-html" value="html" />
        富文本
      </label>
    </RadioGroup>
  );
}

describe("RadioGroup", () => {
  it("updates checked state through the associated label", async () => {
    const user = userEvent.setup();

    render(<RadioGroupHarness />);

    expect(screen.getByRole("radiogroup", { name: "消息样式" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "纯文本" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "富文本" })).not.toBeChecked();

    await user.click(screen.getByText("富文本"));

    expect(screen.getByRole("radio", { name: "纯文本" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "富文本" })).toBeChecked();
  });

  it("does not select disabled items", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <RadioGroup value="plain" onValueChange={onValueChange} aria-label="消息样式">
        <label htmlFor="format-plain-disabled">
          <RadioGroupItem id="format-plain-disabled" value="plain" />
          纯文本
        </label>
        <label htmlFor="format-html-disabled">
          <RadioGroupItem id="format-html-disabled" value="html" disabled />
          富文本
        </label>
      </RadioGroup>,
    );

    const htmlRadio = screen.getByRole("radio", { name: "富文本" });
    expect(htmlRadio).toBeDisabled();

    await user.click(screen.getByText("富文本"));

    expect(onValueChange).not.toHaveBeenCalled();
    expect(htmlRadio).not.toBeChecked();
  });
});
