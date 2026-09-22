// 截断 Tooltip 测试保护测量逻辑，避免长文本未溢出时仍创建无意义 tooltip。
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TruncatedTooltipText } from "./truncated-tooltip-text";

function renderWithTooltipProvider(ui: ReactNode) {
  return render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

function setElementSize(element: Element, data: { scrollWidth: number; clientWidth: number; scrollHeight?: number; clientHeight?: number }) {
  Object.defineProperties(element, {
    scrollWidth: { configurable: true, value: data.scrollWidth },
    clientWidth: { configurable: true, value: data.clientWidth },
    scrollHeight: { configurable: true, value: data.scrollHeight ?? 20 },
    clientHeight: { configurable: true, value: data.clientHeight ?? 20 },
  });
  fireEvent.resize(window);
}

describe("TruncatedTooltipText", () => {
  it("does not show a tooltip when text fits", async () => {
    const user = userEvent.setup();

    renderWithTooltipProvider(<TruncatedTooltipText text="短文本" />);

    setElementSize(screen.getByText("短文本"), { scrollWidth: 100, clientWidth: 200 });
    await user.hover(screen.getByText("短文本"));

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows the full text on hover when text overflows", async () => {
    const user = userEvent.setup();
    const longText = "2026-05-15 06:33 · Asia/Shanghai";

    renderWithTooltipProvider(<TruncatedTooltipText text={longText} />);

    setElementSize(screen.getByText(longText), { scrollWidth: 320, clientWidth: 120 });
    await user.hover(screen.getByText(longText));

    expect(await screen.findByRole("tooltip")).toHaveTextContent(longText);
  });

  it("uses transform-origin animation without directional slide classes", async () => {
    const user = userEvent.setup();
    const longText = "不会再从左上角飘过来的完整内容";

    renderWithTooltipProvider(<TruncatedTooltipText text={longText} />);

    setElementSize(screen.getByText(longText), { scrollWidth: 320, clientWidth: 120 });
    await user.hover(screen.getByText(longText));

    await screen.findByRole("tooltip");
    expect(document.body.innerHTML).toContain("origin-(--radix-tooltip-content-transform-origin)");
    expect(document.body.innerHTML).not.toContain("slide-in-from");
  });

  it("recomputes overflow when the container size changes", async () => {
    const user = userEvent.setup();
    const text = "变更后需要显示完整内容";

    renderWithTooltipProvider(<TruncatedTooltipText text={text} />);

    setElementSize(screen.getByText(text), { scrollWidth: 100, clientWidth: 200 });
    await user.hover(screen.getByText(text));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.unhover(screen.getByText(text));

    setElementSize(screen.getByText(text), { scrollWidth: 300, clientWidth: 120 });

    await user.hover(screen.getByText(text));

    expect(await screen.findByRole("tooltip")).toHaveTextContent(text);
  });

  it("does not add a tab stop for plain display text", async () => {
    renderWithTooltipProvider(<TruncatedTooltipText text="需要 Tooltip 的纯文本" />);

    const trigger = screen.getByText("需要 Tooltip 的纯文本");
    setElementSize(trigger, { scrollWidth: 320, clientWidth: 120 });

    expect(trigger).not.toHaveAttribute("tabindex");
  });
});
