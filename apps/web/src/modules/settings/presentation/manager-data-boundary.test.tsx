import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SettingsReadState } from "../application/settings-read-state";
import { ManagerDataBoundary } from "./manager-data-boundary";

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "common.loading": "加载中",
      "settings.managerLoadFailed": "加载失败",
      "settings.managerRefreshFailed": "未更新",
      "settings.managerRetry": "重试",
    })[key] ?? key,
  }),
}));

function readState(overrides: Partial<SettingsReadState<string>> = {}): SettingsReadState<string> {
  return {
    data: "cached content",
    hasData: true,
    error: null,
    isInitialLoading: false,
    isRefreshing: false,
    retry: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("ManagerDataBoundary", () => {
  it("renders only the loading state before the first result", () => {
    render(
      <ManagerDataBoundary state={readState({ data: undefined, hasData: false, isInitialLoading: true })}>
        <div>domain content</div>
      </ManagerDataBoundary>,
    );

    expect(screen.getByRole("status", { name: "加载中" })).toBeInTheDocument();
    expect(screen.queryByText("domain content")).not.toBeInTheDocument();
  });

  it("shows a recoverable first-load error without rendering a false empty state", async () => {
    const user = userEvent.setup();
    const retry = vi.fn().mockResolvedValue(undefined);
    render(
      <ManagerDataBoundary
        state={readState({ data: undefined, hasData: false, error: new Error("failed"), retry })}
      >
        <div>domain content</div>
      </ManagerDataBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("加载失败");
    expect(screen.queryByText("domain content")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps cached content visible and marks a stale refresh failure", () => {
    render(
      <ManagerDataBoundary state={readState({ error: new Error("refresh failed") })}>
        <div>domain content</div>
      </ManagerDataBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("未更新");
    expect(screen.getByText("domain content")).toBeInTheDocument();
  });

  it("locks retry while recovering from a first-load failure", () => {
    render(
      <ManagerDataBoundary state={readState({ data: undefined, hasData: false, error: new Error("failed"), isRefreshing: true })}>
        <div>domain content</div>
      </ManagerDataBoundary>,
    );

    expect(screen.getByRole("button", { name: "加载中" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "加载中" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("domain content")).not.toBeInTheDocument();
  });

  it("locks retry while stale data is refreshing", () => {
    render(
      <ManagerDataBoundary state={readState({ error: new Error("refresh failed"), isRefreshing: true })}>
        <div>domain content</div>
      </ManagerDataBoundary>,
    );

    expect(screen.getByRole("button", { name: "加载中" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "加载中" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("domain content")).toBeInTheDocument();
  });
});
