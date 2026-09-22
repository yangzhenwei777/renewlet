import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { describe, expect, it } from "vitest";
import { AppScrollRestoration } from "./app-scroll-restoration";

function TestRoutes() {
  const navigate = useNavigate();

  return (
    <>
      <AppScrollRestoration />
      <Link to="/calendar">日历</Link>
      <Link to="/statistics">统计</Link>
      <button type="button" onClick={() => navigate(-1)}>
        返回
      </button>
      <Routes>
        <Route path="/subscriptions" element={<h1>订阅</h1>} />
        <Route path="/calendar" element={<h1>日历页</h1>} />
        <Route path="/statistics" element={<h1>统计页</h1>} />
      </Routes>
    </>
  );
}

function renderWithRoot(initialEntry = "/subscriptions") {
  return render(
    <div id="root" style={{ height: 800, overflowY: "auto" }}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <TestRoutes />
      </MemoryRouter>
    </div>,
  );
}

function getRoot() {
  const root = document.getElementById("root");
  if (!root) throw new Error("Expected #root test scroll container");
  return root;
}

describe("AppScrollRestoration", () => {
  it("resets the app scroll container when navigating to a new page", async () => {
    const user = userEvent.setup();
    renderWithRoot();
    const root = getRoot();
    root.scrollTop = 420;
    fireEvent.scroll(root);

    await user.click(screen.getByRole("link", { name: "日历" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "日历页" })).toBeInTheDocument();
      expect(root.scrollTop).toBe(0);
    });
  });

  it("restores the previous entry scroll position on browser history navigation", async () => {
    const user = userEvent.setup();
    renderWithRoot();
    const root = getRoot();
    root.scrollTop = 640;
    fireEvent.scroll(root);

    await user.click(screen.getByRole("link", { name: "日历" }));
    await waitFor(() => expect(root.scrollTop).toBe(0));

    root.scrollTop = 120;
    fireEvent.scroll(root);
    await user.click(screen.getByRole("button", { name: "返回" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "订阅" })).toBeInTheDocument();
      expect(root.scrollTop).toBe(640);
    });
  });

  it("keeps repeated new-page navigations at the top without depending on content height", async () => {
    const user = userEvent.setup();
    renderWithRoot();
    const root = getRoot();
    Object.defineProperty(root, "scrollHeight", { configurable: true, value: 0 });
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 0 });

    root.scrollTop = 300;
    fireEvent.scroll(root);
    await user.click(screen.getByRole("link", { name: "日历" }));
    await waitFor(() => expect(root.scrollTop).toBe(0));

    root.scrollTop = 500;
    fireEvent.scroll(root);
    await user.click(screen.getByRole("link", { name: "统计" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "统计页" })).toBeInTheDocument();
      expect(root.scrollTop).toBe(0);
    });
  });

  it("does not crash when the app scroll container is missing", () => {
    expect(() => {
      render(
        <MemoryRouter initialEntries={["/subscriptions"]}>
          <TestRoutes />
        </MemoryRouter>,
      );
    }).not.toThrow();
  });
});
