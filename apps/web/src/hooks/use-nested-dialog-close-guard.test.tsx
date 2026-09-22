import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useNestedDialogCloseGuard } from "./use-nested-dialog-close-guard";

describe("useNestedDialogCloseGuard", () => {
  it("guards the parent through the nested dialog focus handoff", async () => {
    const onParentOpenChange = vi.fn();
    const { result } = renderHook(() => useNestedDialogCloseGuard(true, onParentOpenChange));

    act(() => result.current.handleNestedDialogOpenChange(true));
    act(() => result.current.handleParentOpenChange(false));
    expect(onParentOpenChange).not.toHaveBeenCalled();

    act(() => {
      result.current.handleNestedDialogOpenChange(false);
      result.current.handleParentOpenChange(false);
    });
    expect(onParentOpenChange).not.toHaveBeenCalled();

    await act(async () => Promise.resolve());
    act(() => result.current.handleParentOpenChange(false));
    expect(onParentOpenChange).toHaveBeenCalledWith(false);
  });
});
