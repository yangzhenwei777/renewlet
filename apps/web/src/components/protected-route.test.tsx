// ProtectedRoute 测试守住私有页面延迟挂载和 next 参数保留，避免未登录时先打私有 API。
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { ProtectedRoute } from "./protected-route";

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: mocks.useSession,
  },
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderProtectedRoute(initialEntry = "/settings?tab=notifications", adminOnly = false) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/settings"
          element={(
            <ProtectedRoute adminOnly={adminOnly}>
              <div>private settings</div>
            </ProtectedRoute>
          )}
        />
        <Route
          path="/admin/users"
          element={(
            <ProtectedRoute adminOnly>
              <div>admin users</div>
            </ProtectedRoute>
          )}
        />
        <Route path="/login" element={<LocationProbe />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("ProtectedRoute", () => {
  beforeEach(() => {
    mocks.useSession.mockReset();
  });

  it("redirects unauthenticated users before rendering protected content", () => {
    mocks.useSession.mockReturnValue({ data: null, isPending: false });

    renderProtectedRoute();

    expect(screen.queryByText("private settings")).not.toBeInTheDocument();
    const locations = screen.getAllByTestId("location");
    expect(locations[locations.length - 1]).toHaveTextContent("/login?next=%2Fsettings%3Ftab%3Dnotifications");
  });

  it("shows the matching route skeleton while cold session validation is pending", () => {
    mocks.useSession.mockReturnValue({ data: null, isPending: true });

    renderProtectedRoute();

    expect(screen.queryByText("private settings")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-page-skeleton")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("location")).toHaveTextContent("/settings?tab=notifications");
  });

  it("keeps rendering protected content while a cached session refreshes", () => {
    mocks.useSession.mockReturnValue({
      data: {
        session: { expiresAt: "2026-07-01T00:00:00.000Z" },
        user: { id: "user-1", email: "alice@example.com", name: "Alice", role: "admin", banned: false },
      },
      isPending: true,
    });

    renderProtectedRoute();

    expect(screen.getByText("private settings")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-page-skeleton")).not.toBeInTheDocument();
  });

  it("renders protected content for authenticated users", () => {
    mocks.useSession.mockReturnValue({
      data: {
        session: { expiresAt: "2026-07-01T00:00:00.000Z" },
        user: { id: "user-1", email: "alice@example.com", name: "Alice", role: "admin", banned: false },
      },
      isPending: false,
    });

    renderProtectedRoute();

    expect(screen.getByText("private settings")).toBeInTheDocument();
  });

  it("redirects authenticated non-admin users away from admin-only routes before mounting them", () => {
    mocks.useSession.mockReturnValue({
      data: {
        session: { expiresAt: "2026-07-01T00:00:00.000Z" },
        user: { id: "user-1", email: "alice@example.com", name: "Alice", role: "user", banned: false },
      },
      isPending: false,
    });

    renderProtectedRoute("/admin/users");

    expect(screen.queryByText("admin users")).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/settings");
  });

  it("renders admin-only routes for enabled admins", () => {
    mocks.useSession.mockReturnValue({
      data: {
        session: { expiresAt: "2026-07-01T00:00:00.000Z" },
        user: { id: "admin-1", email: "admin@example.com", name: "Admin", role: "admin", banned: false },
      },
      isPending: false,
    });

    renderProtectedRoute("/admin/users");

    expect(screen.getByText("admin users")).toBeInTheDocument();
  });
});
