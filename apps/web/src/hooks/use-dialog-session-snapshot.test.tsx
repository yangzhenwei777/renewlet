import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDialogSessionSnapshot } from "@/hooks/use-dialog-session-snapshot";

function Harness({ open, ownerKey, value }: { open: boolean; ownerKey: string | null; value: string }) {
  const visibleValue = useDialogSessionSnapshot(open, ownerKey, value);
  return <output>{visibleValue}</output>;
}

describe("useDialogSessionSnapshot", () => {
  it("keeps late data out of a closing session and exposes it on the next open", () => {
    const { rerender } = render(<Harness open ownerKey="subscription-1" value="骨架" />);

    rerender(<Harness open={false} ownerKey="subscription-1" value="骨架" />);
    rerender(<Harness open={false} ownerKey="subscription-1" value="真实内容" />);
    expect(screen.getByText("骨架")).toBeInTheDocument();

    rerender(<Harness open ownerKey="subscription-1" value="真实内容" />);
    expect(screen.getByText("真实内容")).toBeInTheDocument();
  });

  it("releases the frozen snapshot when the session owner is cleared", () => {
    const { rerender } = render(<Harness open ownerKey="subscription-1" value="详情" />);

    rerender(<Harness open={false} ownerKey="subscription-1" value="空" />);
    expect(screen.getByText("详情")).toBeInTheDocument();

    rerender(<Harness open={false} ownerKey={null} value="空" />);
    expect(screen.getByText("空")).toBeInTheDocument();
  });
});
