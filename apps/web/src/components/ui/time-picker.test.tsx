// TimePicker 测试保护本地 HH:mm 选择器的滚动和快捷值，通知时间不能退化成任意字符串。
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimePicker } from "./time-picker";

function installScrollMocks() {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options?: ScrollToOptions | number, y?: number) {
      if (typeof options === "object") {
        this.scrollTop = options.top ?? this.scrollTop;
        return;
      }

      if (typeof y === "number") {
        this.scrollTop = y;
      }
    },
  });

  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });

  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
}

async function openPicker(value = "08:12", onChange = vi.fn()) {
  const user = userEvent.setup();

  render(<TimePicker value={value} onChange={onChange} />);
  await user.click(screen.getByRole("button", { name: new RegExp(value) }));

  return {
    onChange,
    hourColumn: await screen.findByRole("spinbutton", { name: "时" }),
    minuteColumn: await screen.findByRole("spinbutton", { name: "分" }),
  };
}

function renderWithAppRoot(ui: ReactElement) {
  const root = document.createElement("div");
  root.id = "root";
  root.style.overflowY = "auto";
  root.style.overscrollBehaviorY = "contain";
  document.body.appendChild(root);

  return {
    root,
    ...render(ui, { container: root }),
  };
}

describe("TimePicker", () => {
  beforeEach(() => {
    installScrollMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.getElementById("root")?.remove();
  });

  it("renders the current time and exposes wheel column values", async () => {
    const { hourColumn, minuteColumn } = await openPicker("08:12");

    expect(screen.getByRole("button", { name: /08:12/ })).toBeInTheDocument();
    expect(hourColumn).toHaveAttribute("aria-valuenow", "8");
    expect(hourColumn).toHaveAttribute("aria-valuetext", "08");
    expect(minuteColumn).toHaveAttribute("aria-valuenow", "12");
    expect(minuteColumn).toHaveAttribute("aria-valuetext", "12");
  });

  it("forwards the field description relationship to the trigger", () => {
    render(
      <TimePicker
        value="08:12"
        onChange={vi.fn()}
        ariaLabel="通知时间"
        ariaDescribedBy="notification-time-description"
      />,
    );

    expect(screen.getByRole("button", { name: /通知时间/ })).toHaveAttribute(
      "aria-describedby",
      "notification-time-description",
    );
  });

  it("selects an option by click", async () => {
    const onChange = vi.fn();
    const { hourColumn } = await openPicker("08:12", onChange);

    fireEvent.click(within(hourColumn).getByText("09"));

    expect(onChange).toHaveBeenLastCalledWith("09:12");
    expect(screen.getByRole("button", { name: /09:12/ })).toBeInTheDocument();
  });

  it("syncs wheel columns when the controlled value changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<TimePicker value="08:12" onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /08:12/ }));
    rerender(<TimePicker value="21:01" onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /21:01/ })).toBeInTheDocument();
      expect(screen.getByRole("spinbutton", { name: "时" })).toHaveAttribute("aria-valuenow", "21");
      expect(screen.getByRole("spinbutton", { name: "分" })).toHaveAttribute("aria-valuenow", "1");
    });
  });

  it("snaps to the nearest item after mouse drag", async () => {
    const onChange = vi.fn();
    const { hourColumn } = await openPicker("08:12", onChange);

    expect(hourColumn.scrollTop).toBe(320);

    fireEvent.pointerDown(hourColumn, { pointerId: 1, pointerType: "mouse", button: 0, clientY: 100 });
    fireEvent.pointerMove(hourColumn, { pointerId: 1, pointerType: "mouse", buttons: 1, clientY: 20 });

    expect(hourColumn).toHaveAttribute("aria-valuenow", "10");

    fireEvent.pointerUp(hourColumn, { pointerId: 1, pointerType: "mouse", button: 0, clientY: 20 });

    expect(onChange).toHaveBeenLastCalledWith("10:12");
    expect(hourColumn.scrollTop).toBe(400);
  });

  it("snaps native scroll changes after the debounce window", async () => {
    const onChange = vi.fn();
    const { minuteColumn } = await openPicker("08:12", onChange);
    vi.useFakeTimers();

    minuteColumn.scrollTop = 16 * 40;
    fireEvent.scroll(minuteColumn);

    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(120);

    expect(onChange).toHaveBeenLastCalledWith("08:16");
    expect(minuteColumn.scrollTop).toBe(640);
  });

  it("keeps the picker as the original wheel-only surface", async () => {
    const { hourColumn } = await openPicker("08:12");

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "小时加一" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "小时减一" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分钟加一" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分钟减一" })).not.toBeInTheDocument();
    expect(within(hourColumn).getByText("08")).toHaveStyle({ scrollSnapStop: "always" });
  });

  it("blocks horizontal trackpad wheel without changing the selected time", async () => {
    const onChange = vi.fn();
    const { hourColumn } = await openPicker("08:12", onChange);
    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 72,
      deltaY: 4,
    });

    fireEvent(hourColumn, wheelEvent);

    expect(wheelEvent.defaultPrevented).toBe(true);
    expect(hourColumn.scrollLeft).toBe(0);
    expect(hourColumn).toHaveAttribute("aria-valuenow", "8");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps vertical wheel input on the native scroll and snap path", async () => {
    const onChange = vi.fn();
    const { hourColumn } = await openPicker("08:12", onChange);
    const nextHourEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 40,
    });

    fireEvent(hourColumn, nextHourEvent);

    expect(nextHourEvent.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();

    vi.useFakeTimers();
    hourColumn.scrollTop = 9 * 40;
    fireEvent.scroll(hourColumn);

    vi.advanceTimersByTime(120);

    expect(onChange).toHaveBeenLastCalledWith("09:12");
    expect(hourColumn.scrollTop).toBe(360);
  });

  it("suppresses the click that follows a drag", async () => {
    const onChange = vi.fn();
    const { hourColumn } = await openPicker("08:12", onChange);

    fireEvent.pointerDown(hourColumn, { pointerId: 1, pointerType: "mouse", button: 0, clientY: 100 });
    fireEvent.pointerMove(hourColumn, { pointerId: 1, pointerType: "mouse", buttons: 1, clientY: 20 });
    fireEvent.pointerUp(hourColumn, { pointerId: 1, pointerType: "mouse", button: 0, clientY: 20 });
    fireEvent.click(within(hourColumn).getByText("23"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("10:12");
  });

  it("supports keyboard increment, decrement, and boundaries", async () => {
    const onChange = vi.fn();
    const { hourColumn } = await openPicker("08:12", onChange);

    fireEvent.keyDown(hourColumn, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("09:12");

    fireEvent.keyDown(hourColumn, { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith("08:12");

    fireEvent.keyDown(hourColumn, { key: "PageDown" });
    expect(onChange).toHaveBeenLastCalledWith("03:12");

    fireEvent.keyDown(hourColumn, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("00:12");

    fireEvent.keyDown(hourColumn, { key: "ArrowDown" });
    expect(onChange).toHaveBeenCalledTimes(4);

    fireEvent.keyDown(hourColumn, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("23:12");

    fireEvent.keyDown(hourColumn, { key: "ArrowUp" });
    expect(onChange).toHaveBeenCalledTimes(5);
  });

  it("locks the app scroll root while the default picker is open", async () => {
    const user = userEvent.setup();
    const { root, unmount } = renderWithAppRoot(<TimePicker value="08:12" onChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /08:12/ }));

    expect(root).toHaveStyle({ overflowY: "hidden", overscrollBehaviorY: "none" });
    expect(root).toHaveAttribute("data-app-scroll-locked");

    await user.click(screen.getByRole("button", { name: /08:12/ }));

    expect(root).toHaveStyle({ overflowY: "auto", overscrollBehaviorY: "contain" });
    expect(root).not.toHaveAttribute("data-app-scroll-locked");

    await user.click(screen.getByRole("button", { name: /08:12/ }));
    expect(root).toHaveStyle({ overflowY: "hidden" });

    unmount();

    expect(root).toHaveStyle({ overflowY: "auto", overscrollBehaviorY: "contain" });
    expect(root).not.toHaveAttribute("data-app-scroll-locked");
  });

  it("uses the same wheel picker with a compact trigger", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { root, rerender } = renderWithAppRoot(
      <TimePicker
        value="04:30"
        onChange={onChange}
        density="compact"
        ariaLabel="执行时间"
        disabled
        className="w-full sm:max-w-36"
      />,
    );

    expect(screen.getByRole("button", { name: /执行时间/ })).toHaveTextContent("04:30");
    expect(screen.getByRole("button", { name: /执行时间/ })).toHaveClass("h-9", "bg-background", "sm:max-w-36");
    expect(screen.getByRole("button", { name: /执行时间/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /执行时间/ }));
    expect(screen.queryByRole("spinbutton", { name: "时" })).not.toBeInTheDocument();

    rerender(
      <TimePicker
        value="04:30"
        onChange={onChange}
        density="compact"
        ariaLabel="执行时间"
        className="w-full sm:max-w-36"
      />,
    );

    await user.click(screen.getByRole("button", { name: /执行时间/ }));
    const hourColumn = await screen.findByRole("spinbutton", { name: "时" });
    const minuteColumn = await screen.findByRole("spinbutton", { name: "分" });

    expect(root).toHaveStyle({ overflowY: "hidden", overscrollBehaviorY: "none" });
    expect(root).toHaveAttribute("data-app-scroll-locked");
    expect(screen.queryByText("08:00")).not.toBeInTheDocument();
    expect(within(hourColumn).queryByText("24")).not.toBeInTheDocument();

    await user.click(within(hourColumn).getByText("23"));
    expect(onChange).toHaveBeenLastCalledWith("23:30");

    await user.click(within(minuteColumn).getByText("59"));
    expect(onChange).toHaveBeenLastCalledWith("23:59");
  });
});
