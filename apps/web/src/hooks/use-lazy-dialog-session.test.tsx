import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { createLazyDialogResource, useLazyDialogSession } from "@/hooks/use-lazy-dialog-session";

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("useLazyDialogSession", () => {
  it("keeps a late module out of the closing session and reuses its cache on the next open", async () => {
    const module = deferred<string>();
    const loader = vi.fn(() => module.promise);
    const resource = createLazyDialogResource(loader);

    function Harness() {
      const [open, setOpen] = useState(true);
      const { value, sessionKey } = useLazyDialogSession(open, resource);
      return (
        <>
          <button type="button" onClick={() => setOpen((current) => !current)}>切换</button>
          <output>{value ?? "骨架"}</output>
          <span data-testid="session-key">{sessionKey}</span>
        </>
      );
    }

    render(<Harness />);
    expect(screen.getByText("骨架")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "切换" }));
    await act(async () => {
      module.resolve("真实内容");
      await module.promise;
    });
    expect(screen.getByText("骨架")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "切换" }));
    expect(screen.getByText("真实内容")).toBeInTheDocument();
    expect(screen.getByTestId("session-key")).toHaveTextContent("1");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("deduplicates the module request when Strict Mode replays layout effects", async () => {
    const module = deferred<string>();
    const loader = vi.fn(() => module.promise);
    const resource = createLazyDialogResource(loader);

    function Harness() {
      const { value } = useLazyDialogSession(true, resource);
      return <output>{value ?? "骨架"}</output>;
    }

    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    await act(async () => {
      module.resolve("真实内容");
      await module.promise;
    });

    expect(screen.getByText("真实内容")).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
