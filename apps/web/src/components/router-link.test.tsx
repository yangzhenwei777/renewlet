import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Link, { NavLink } from "./router-link";

const mocks = vi.hoisted(() => ({
  preloadRoute: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/route-resources", () => ({
  preloadRoute: mocks.preloadRoute,
}));

function renderWithProviders(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("router-link route preload", () => {
  beforeEach(() => {
    mocks.preloadRoute.mockClear();
  });

  it("preloads internal Link targets on intent events", () => {
    renderWithProviders(<Link href="/settings">Settings</Link>);
    const link = screen.getByRole("link", { name: "Settings" });

    fireEvent.pointerEnter(link);
    fireEvent.focus(link);
    fireEvent.touchStart(link);

    expect(mocks.preloadRoute).toHaveBeenCalledTimes(3);
    expect(mocks.preloadRoute).toHaveBeenCalledWith("/settings", expect.any(QueryClient));
  });

  it("preloads NavLink targets through the same adapter", () => {
    renderWithProviders(<NavLink href="/subscriptions">Subscriptions</NavLink>);

    fireEvent.pointerEnter(screen.getByRole("link", { name: "Subscriptions" }));

    expect(mocks.preloadRoute).toHaveBeenCalledWith("/subscriptions", expect.any(QueryClient));
  });

  it("honors routePreload=none for links that should stay cold", () => {
    renderWithProviders(<Link href="/privacy" routePreload="none">Privacy</Link>);

    fireEvent.pointerEnter(screen.getByRole("link", { name: "Privacy" }));

    expect(mocks.preloadRoute).not.toHaveBeenCalled();
  });
});
