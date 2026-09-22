import { render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet } from "react-router";
import { describe, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("@/components/app-scroll-restoration", () => ({
  AppScrollRestoration: () => null,
}));

vi.mock("@/components/protected-route", () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/components/private-app-shell", () => ({
  default: () => <Outlet />,
}));

vi.mock("@/pages/settings", () => new Promise(() => undefined));

describe("App route fallback", () => {
  it("uses the settings page skeleton for the settings route while the chunk loads", () => {
    // settings chunk 悬挂时必须展示设置页骨架，避免懒加载 fallback 错落到 dashboard 占位。
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("settings-page-skeleton")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("settings-page-skeleton-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-page-skeleton")).not.toBeInTheDocument();
  });
});
