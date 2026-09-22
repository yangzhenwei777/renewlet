// LoadingButtonContent 测试保护共享 loading 按钮宽度契约，避免长文案再次用绝对定位贴边。
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { LoadingButtonContent } from "./settings-shared-controls";

describe("LoadingButtonContent", () => {
  it("keeps the loading label in layout while idle", () => {
    const { container } = render(
      <Button type="button">
        <LoadingButtonContent loading={false} loadingLabel="安装中...">
          安装命令
        </LoadingButtonContent>
      </Button>,
    );

    expect(screen.getByRole("button", { name: "安装命令" })).toBeInTheDocument();
    const loadingLayer = screen.getByText("安装中...");
    expect(loadingLayer).toHaveAttribute("aria-hidden", "true");
    expect(loadingLayer).toHaveClass("invisible");
    expect(container.querySelector(".absolute")).not.toBeInTheDocument();
    expect(container.querySelector(".inset-0")).not.toBeInTheDocument();
  });

  it("uses the loading label as the accessible button name while busy", () => {
    const { container } = render(
      <Button type="button" aria-busy="true">
        <LoadingButtonContent loading loadingLabel="安装中...">
          安装命令
        </LoadingButtonContent>
      </Button>,
    );

    expect(screen.getByRole("button", { name: "安装中..." })).toHaveAttribute("aria-busy", "true");
    const idleLayer = screen.getByText("安装命令");
    expect(idleLayer).toHaveAttribute("aria-hidden", "true");
    expect(idleLayer).toHaveClass("invisible");
    expect(screen.getByText("安装中...").querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".absolute")).not.toBeInTheDocument();
    expect(container.querySelector(".inset-0")).not.toBeInTheDocument();
  });
});
