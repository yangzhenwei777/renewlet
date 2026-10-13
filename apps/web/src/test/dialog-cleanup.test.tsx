import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

describe.sequential.each(["real", "fake"] as const)("dialog test lifecycle with %s timers", (timers) => {
  const unmountEvents: Event[] = [];

  it("leaves an open dialog for the shared teardown", () => {
    if (timers === "fake") vi.useFakeTimers();
    render(
      <Dialog open>
        <DialogContent onCloseAutoFocus={(event) => { unmountEvents.push(event); }}>
          <DialogTitle>Fixture</DialogTitle>
          <DialogDescription>Fixture description</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(unmountEvents).toHaveLength(0);
  });

  it("finishes asynchronous focus cleanup before the next test and jsdom teardown", () => {
    expect(unmountEvents).toHaveLength(1);
    expect(unmountEvents[0]).toBeInstanceOf(window.Event);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
