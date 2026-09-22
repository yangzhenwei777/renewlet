import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MobileBottomDrawerContent, MobileDrawerRoot } from "@/components/ui/mobile-drawer";

describe("MobileBottomDrawerContent", () => {
  it("renders the shared bottom drawer frame with a larger mobile close target", () => {
    render(
      <MobileDrawerRoot open onOpenChange={vi.fn()} shouldScaleBackground={false}>
        <MobileBottomDrawerContent
          title="筛选标签"
          description="移动端筛选标签"
          descriptionMode="sr-only"
          closeLabel="关闭"
          data-testid="mobile-drawer"
        >
          <p>抽屉内容</p>
        </MobileBottomDrawerContent>
      </MobileDrawerRoot>,
    );

    const drawer = screen.getByTestId("mobile-drawer");
    expect(drawer).toHaveAttribute("role", "dialog");
    expect(drawer).toHaveClass("h5-drawer-panel", "overflow-hidden", "z-50");
    expect(drawer.querySelector("[data-vaul-handle]")).not.toBeNull();
    expect(within(drawer).getByText("抽屉内容").parentElement).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
    expect(within(drawer).getByRole("button", { name: "关闭" })).toHaveClass("touch-target", "h-10", "w-10");

    const title = within(drawer).getByRole("heading", { name: "筛选标签" });
    expect(title.parentElement?.parentElement).toHaveClass("flex", "min-w-0", "flex-1");
    expect(title.parentElement?.parentElement?.children).toHaveLength(1);
  });

  it("keeps a decorative icon outside the accessible title and aligns the text stack beside it", () => {
    render(
      <MobileDrawerRoot open onOpenChange={vi.fn()} shouldScaleBackground={false}>
        <MobileBottomDrawerContent
          title="订阅详情"
          description="查看订阅信息"
          closeLabel="关闭"
          icon={(
            <span data-testid="drawer-icon" className="h-12 w-12">
              品牌图标
            </span>
          )}
          data-testid="mobile-drawer-with-icon"
        >
          <p>抽屉内容</p>
        </MobileBottomDrawerContent>
      </MobileDrawerRoot>,
    );

    const drawer = screen.getByTestId("mobile-drawer-with-icon");
    const title = within(drawer).getByRole("heading", { name: "订阅详情" });
    const description = within(drawer).getByText("查看订阅信息");
    const iconWrapper = screen.getByTestId("drawer-icon").parentElement;
    const textStack = title.parentElement;

    expect(drawer).toHaveAccessibleName("订阅详情");
    expect(title).toHaveAccessibleName("订阅详情");
    expect(iconWrapper).toHaveAttribute("aria-hidden", "true");
    expect(iconWrapper).toHaveClass("shrink-0");
    expect(iconWrapper?.nextElementSibling).toBe(textStack);
    expect(textStack).toHaveClass("min-w-0", "flex-1");
    expect(textStack).toContainElement(description);
  });

  it("allows business drawers to own their body layout while keeping shared chrome", () => {
    render(
      <MobileDrawerRoot open onOpenChange={vi.fn()} shouldScaleBackground={false}>
        <MobileBottomDrawerContent
          title="云端快照"
          description="查看云端快照"
          closeLabel="关闭"
          bodyClassName={null}
          actions={<button type="button">刷新</button>}
          data-testid="snapshot-drawer"
        >
          <div data-testid="snapshot-scroll">快照列表</div>
        </MobileBottomDrawerContent>
      </MobileDrawerRoot>,
    );

    const drawer = screen.getByTestId("snapshot-drawer");
    expect(within(drawer).getByRole("button", { name: "刷新" })).toBeInTheDocument();
    expect(screen.getByTestId("snapshot-scroll").parentElement).toBe(drawer);
  });
});
