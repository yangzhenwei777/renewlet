// Sonner bridge 测试保护 toast 适配层，避免旧 useToast 调用与新通知组件的参数语义分叉。
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "./sonner";

vi.mock("@/lib/theme-provider", () => ({
  useTheme: () => ({
    theme: "dark",
  }),
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        "common.notifications": "通知",
        "common.dismissNotification": "关闭通知",
      };
      return messages[key] ?? key;
    },
  }),
}));

function flushSonnerQueue() {
  act(() => {
    vi.advanceTimersByTime(0);
  });
}

describe("Sonner Toaster", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    toast.dismiss();
    vi.advanceTimersByTime(0);
  });

  afterEach(() => {
    act(() => {
      toast.dismiss();
      vi.advanceTimersByTime(0);
      vi.clearAllTimers();
    });
  });

  it("renders status icons for success and error toasts", () => {
    render(<Toaster />);

    act(() => {
      toast.success("设置已保存");
    });
    flushSonnerQueue();
    expect(screen.getByText("设置已保存")).toBeInTheDocument();
    expect(screen.getByTestId("toast-success-icon")).toBeInTheDocument();

    act(() => {
      toast.error("保存失败");
    });
    flushSonnerQueue();
    expect(screen.getByText("保存失败")).toBeInTheDocument();
    expect(screen.getByTestId("toast-error-icon")).toBeInTheDocument();
  });

  it("renders a localized close button", () => {
    render(<Toaster />);

    act(() => {
      toast.success("设置已保存");
    });
    flushSonnerQueue();

    expect(screen.getByRole("button", { name: "关闭通知" })).toBeInTheDocument();
  });

  it("auto-dismisses lightweight toasts after the default duration", async () => {
    render(<Toaster />);

    act(() => {
      toast.success("设置已保存");
    });
    flushSonnerQueue();
    expect(screen.getByText("设置已保存")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5_250);
    });

    expect(screen.queryByText("设置已保存")).not.toBeInTheDocument();
  });
});
