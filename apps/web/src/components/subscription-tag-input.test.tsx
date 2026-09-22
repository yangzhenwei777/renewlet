// 标签输入测试保护分隔符、建议列表、长度上限和 blur 提交流程，避免复合输入在保存前丢标签。
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { SubscriptionTagInput } from "./subscription-tag-input";

function TagInputHarness({
  initialValue = [],
  suggestions = ["Security", "Docs", "Infra"],
}: {
  initialValue?: string[];
  suggestions?: string[];
}) {
  const [tags, setTags] = useState(initialValue);

  return (
    <div>
      <label htmlFor="tags">标签</label>
      <SubscriptionTagInput id="tags" value={tags} onChange={setTags} suggestions={suggestions} />
    </div>
  );
}

describe("SubscriptionTagInput", () => {
  it("anchors suggestions above the input with Radix collision handling", async () => {
    const user = userEvent.setup();

    render(<TagInputHarness initialValue={["Infra"]} />);

    await user.click(screen.getByLabelText("标签"));

    const listbox = await screen.findByRole("listbox");
    const content = listbox.parentElement;
    expect(content).toHaveAttribute("data-side", "top");
    expect(content).toHaveClass("w-(--radix-popover-trigger-width)");
  });

  it("keeps suggestions inside the parent dialog portal so the list remains interactive", async () => {
    const user = userEvent.setup();

    render(
      <Dialog open>
        <DialogContent data-testid="dialog-content">
          <DialogTitle>编辑订阅</DialogTitle>
          <DialogDescription className="sr-only">测试标签列表滚动。</DialogDescription>
          <TagInputHarness
            suggestions={Array.from({ length: 24 }, (_, index) => `Tag ${index + 1}`)}
          />
        </DialogContent>
      </Dialog>,
    );

    await user.click(screen.getByLabelText("标签"));

    const dialogContent = screen.getByTestId("dialog-content");
    const listbox = await screen.findByRole("listbox");
    const popoverContent = screen.getByTestId("subscription-tag-popover");
    await waitFor(() => {
      expect(dialogContent).toContainElement(popoverContent);
    });
    expect(listbox).toHaveClass("overflow-y-auto", "max-h-64");
  });

  it("sizes the input from a mirror wrapper after tags exist", async () => {
    const user = userEvent.setup();

    render(<TagInputHarness initialValue={["Code", "test", "Planning", "Search", "Writing"]} />);

    const input = screen.getByLabelText("标签");
    const sizer = input.closest('[data-slot="subscription-tag-input-sizer"]');
    expect(input).toHaveAttribute("size", "1");
    expect(sizer).toHaveClass("min-w-px");
    expect(sizer).toHaveClass("w-px");
    expect(sizer).toHaveClass("flex-none");
    expect(input).toHaveClass("w-full");
    expect(input).toHaveClass("min-w-0");
    expect(input).not.toHaveClass("basis-[1ch]");
    expect(input).not.toHaveClass("flex-[1_0_1ch]");
    expect(input).not.toHaveClass("min-w-32");

    await user.type(input, "Design");

    expect(sizer).toHaveTextContent("Design");
    expect(sizer).toHaveClass("min-w-[1ch]");
    expect(sizer).not.toHaveClass("w-px");
  });

  it("keeps suggestions open after focus settles and closes them from outside", async () => {
    const user = userEvent.setup();

    render(<TagInputHarness />);

    const input = screen.getByLabelText("标签");
    await user.click(input);
    expect(await screen.findByRole("listbox")).toBeInTheDocument();

    await new Promise((resolve) => window.setTimeout(resolve, 250));

    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await user.click(document.body);

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("selects suggestions and creates tags with keyboard navigation", async () => {
    const user = userEvent.setup();

    render(<TagInputHarness initialValue={["Infra"]} />);

    const input = screen.getByLabelText("标签");
    await user.click(input);
    await user.keyboard("{ArrowDown}{Enter}");

    expect(screen.getByText("Security")).toBeInTheDocument();

    await user.type(input, "AI");
    await user.keyboard("{Enter}");

    expect(screen.getByText("AI")).toBeInTheDocument();
  });

  it("removes chips with Backspace and the remove button", async () => {
    const user = userEvent.setup();

    render(<TagInputHarness initialValue={["Infra", "Security"]} />);

    const input = screen.getByLabelText("标签");
    await user.click(input);
    await user.keyboard("{Backspace}");

    expect(screen.queryByRole("button", { name: "移除标签 Security" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "移除标签 Infra" }));

    expect(screen.queryByRole("button", { name: "移除标签 Infra" })).not.toBeInTheDocument();
  });

  it("closes suggestions with Escape", async () => {
    const user = userEvent.setup();

    render(<TagInputHarness />);

    const input = screen.getByLabelText("标签");
    await user.click(input);
    expect(await screen.findByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps a wide placeholder input before any tag is selected", () => {
    render(<TagInputHarness />);

    const input = screen.getByLabelText("标签");
    const sizer = input.closest('[data-slot="subscription-tag-input-sizer"]');
    expect(sizer).toHaveClass("min-w-32");
    expect(sizer).toHaveClass("flex-1");
  });

  it("keeps mouse selection focused for repeated tag entry", async () => {
    const user = userEvent.setup();
    const focusSpy = vi.spyOn(HTMLInputElement.prototype, "focus");

    render(<TagInputHarness />);

    const input = screen.getByLabelText("标签");
    await user.click(input);
    await user.click(within(await screen.findByRole("listbox")).getByText("Security"));

    expect(screen.getByText("Security")).toBeInTheDocument();
    expect(focusSpy).toHaveBeenCalled();
  });

  it("commits pending text when focus leaves the tag input", async () => {
    const user = userEvent.setup();

    render(<TagInputHarness />);

    const input = screen.getByLabelText("标签");
    await user.click(input);
    await user.type(input, "Renewal");

    expect(screen.queryByRole("button", { name: "移除标签 Renewal" })).not.toBeInTheDocument();

    await user.tab();

    expect(screen.getByRole("button", { name: "移除标签 Renewal" })).toBeInTheDocument();
    expect(input).toHaveValue("");
  });
});
