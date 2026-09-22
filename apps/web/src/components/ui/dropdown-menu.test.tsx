// DropdownMenu primitive 测试保护移动端 overlay 事件抑制，避免触控菜单关闭后把点击透传到底层页面。
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { mockMobileOverlayMatch, resetMobileOverlayTestEnvironment } from "@/components/ui/mobile-overlay.test-utils";

async function finishMobileSheetExit() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

describe("DropdownMenu mobile sheet", () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= vi.fn(() => false);
    Element.prototype.setPointerCapture ??= vi.fn();
    Element.prototype.releasePointerCapture ??= vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetMobileOverlayTestEnvironment();
  });

  it("opens from the trigger click without activating an item from the same tap", async () => {
    mockMobileOverlayMatch();
    const user = userEvent.setup();
    const onDelete = vi.fn();

    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">更多操作</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>编辑</DropdownMenuItem>
          <DropdownMenuItem onClick={onDelete}>删除</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await user.click(screen.getByRole("button", { name: "更多操作" }));

    expect(onDelete).not.toHaveBeenCalled();
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveAttribute("data-vaul-drawer");
    expect(menu).toHaveAttribute("data-mobile-detent", "compact");
    expect(menu.querySelector("[data-vaul-handle]")).not.toBeNull();
    expect(await screen.findByRole("menuitem", { name: "编辑" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeVisible();

    await user.click(screen.getByRole("menuitem", { name: "删除" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("only reserves leading icon space for checked or inset mobile menu items", async () => {
    mockMobileOverlayMatch();
    const user = userEvent.setup();

    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">更多操作</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>编辑</DropdownMenuItem>
          <DropdownMenuItem inset>缩进项</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked>已选项</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await user.click(screen.getByRole("button", { name: "更多操作" }));

    expect(await screen.findByRole("menuitem", { name: "编辑" })).toHaveClass("h5-mobile-option-item");
    expect(screen.getByRole("menuitem", { name: "编辑" })).not.toHaveClass("h5-mobile-option-item-leading");
    expect(screen.getByRole("menuitem", { name: "缩进项" })).toHaveClass("h5-mobile-option-item-leading");
    expect(screen.getByRole("menuitemcheckbox", { name: "已选项" })).toHaveClass("h5-mobile-option-item-leading");
  });

  it("keeps the menu mounted for the mobile backdrop exit animation", async () => {
    mockMobileOverlayMatch();
    const user = userEvent.setup();

    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">更多操作</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>编辑</DropdownMenuItem>
          <DropdownMenuItem>删除</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await user.click(screen.getByRole("button", { name: "更多操作" }));

    const menu = await screen.findByRole("menu");
    const backdrop = menu.closest("[data-mobile-overlay-portal]")?.querySelector("[data-mobile-overlay-backdrop]");
    expect(backdrop).not.toBeNull();

    vi.useFakeTimers();
    fireEvent.click(backdrop as Element);

    expect(screen.getByRole("menu")).toHaveAttribute("data-state", "closed");
    expect(document.body).toHaveAttribute("data-mobile-overlay-open");
    await finishMobileSheetExit();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
