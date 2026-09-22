import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { TelegramBotCommandsDeleteDialog } from "./telegram-bot-commands-delete-dialog";

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "common.cancel": "取消",
      "settings.telegramBotCommandsDelete": "删除命令",
      "settings.telegramBotCommandsDeleting": "删除中...",
      "settings.telegramBotCommandsDeleteTitle": "删除 Telegram Bot 查询命令？",
      "settings.telegramBotCommandsDeleteDescription": "删除后 Telegram 菜单命令会失效，需要时可以重新安装。",
    })[key] ?? key,
  }),
}));

describe("TelegramBotCommandsDeleteDialog", () => {
  it("locks the confirmation while deleting and restores focus after completion", async () => {
    const user = userEvent.setup();
    const focusFallbackRef = createRef<HTMLButtonElement>();
    const onOpenChange = vi.fn();
    let resolveDelete: () => void = () => undefined;
    const onDelete = vi.fn(() => new Promise<void>((resolve) => {
      resolveDelete = resolve;
    }));
    const { rerender } = render(
      <>
        <button ref={focusFallbackRef}>重新安装</button>
        <TelegramBotCommandsDeleteDialog
          open
          pending={false}
          focusFallbackRef={focusFallbackRef}
          onOpenChange={onOpenChange}
          onDelete={onDelete}
        />
      </>,
    );

    const dialog = screen.getByRole("alertdialog", { name: "删除 Telegram Bot 查询命令？" });
    await user.click(within(dialog).getByRole("button", { name: "删除命令" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(dialog).toBeInTheDocument();

    rerender(
      <>
        <button ref={focusFallbackRef}>重新安装</button>
        <TelegramBotCommandsDeleteDialog
          open
          pending
          focusFallbackRef={focusFallbackRef}
          onOpenChange={onOpenChange}
          onDelete={onDelete}
        />
      </>,
    );
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "删除中..." })).toHaveAttribute("aria-busy", "true");

    act(() => resolveDelete());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    rerender(
      <>
        <button ref={focusFallbackRef}>重新安装</button>
        <TelegramBotCommandsDeleteDialog
          open={false}
          pending={false}
          focusFallbackRef={focusFallbackRef}
          onOpenChange={onOpenChange}
          onDelete={onDelete}
        />
      </>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "重新安装" })).toHaveFocus());
  });
});
