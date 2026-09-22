import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";

describe("Button", () => {
  it("keeps the coarse-pointer touch target contract across visual sizes", () => {
    render(
      <>
        <Button size="sm">紧凑操作</Button>
        <Button size="icon" aria-label="图标操作">
          <svg aria-hidden="true" />
        </Button>
      </>,
    );

    expect(screen.getByRole("button", { name: "紧凑操作" })).toHaveClass("touch-target", "h-9");
    expect(screen.getByRole("button", { name: "图标操作" })).toHaveClass("touch-target", "h-10", "w-10");
  });
});
