import { render, screen } from "@testing-library/react";
import { useCallback, useRef } from "react";
import { describe, expect, it } from "vitest";
import { useDeferredDialogInitialFocus } from "@/hooks/use-deferred-dialog-initial-focus";

function Harness({ open, ready, focusKey }: { open: boolean; ready: boolean; focusKey: string }) {
  const targetRef = useRef<HTMLButtonElement>(null);
  const resolveTarget = useCallback(() => targetRef.current, []);
  useDeferredDialogInitialFocus(open, ready, focusKey, resolveTarget);

  return ready ? <button ref={targetRef}>真实操作</button> : <button>骨架操作</button>;
}

describe("useDeferredDialogInitialFocus", () => {
  it("focuses deferred content once and starts a new focus session after close", () => {
    const { rerender } = render(<Harness open ready={false} focusKey="form" />);
    expect(screen.getByRole("button", { name: "骨架操作" })).not.toHaveFocus();

    rerender(<Harness open ready focusKey="form" />);
    expect(screen.getByRole("button", { name: "真实操作" })).toHaveFocus();

    screen.getByRole("button", { name: "真实操作" }).blur();
    rerender(<Harness open ready focusKey="form" />);
    expect(screen.getByRole("button", { name: "真实操作" })).not.toHaveFocus();

    rerender(<Harness open={false} ready focusKey="form" />);
    rerender(<Harness open ready focusKey="form" />);
    expect(screen.getByRole("button", { name: "真实操作" })).toHaveFocus();
  });

  it("focuses the next control when a dialog state machine changes focus key", () => {
    const { rerender } = render(<Harness open ready focusKey="setup" />);
    const target = screen.getByRole("button", { name: "真实操作" });
    target.blur();

    rerender(<Harness open ready focusKey="recovery" />);
    expect(target).toHaveFocus();
  });
});
