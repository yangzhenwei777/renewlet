// Setup 页面测试保护首次管理员创建 UX；是否允许初始化仍由后端 setup route 最终裁决。
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import SetupPage from "./setup";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  useSetupStatus: vi.fn(),
}));

vi.mock("@/hooks/use-setup-status", () => ({
  useSetupStatus: mocks.useSetupStatus,
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: mocks.apiFetch,
}));

function renderSetup() {
  return render(
    <MemoryRouter>
      <SetupPage />
    </MemoryRouter>,
  );
}

describe("Setup page", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.useSetupStatus.mockReturnValue({
      setupRequired: true,
      setupEnabled: true,
      demoMode: false,
      turnstile: { enabled: false, siteKey: "" },
      isLoading: false,
    });
  });

  it("uses form errors for short passwords and clears them on input", async () => {
    const user = userEvent.setup();
    const { container } = renderSetup();

    expect(container.querySelector("form")).toHaveAttribute("novalidate");

    await user.type(screen.getByLabelText("登录邮箱"), "admin@example.com");
    await user.type(screen.getByLabelText("密码"), "12");
    await user.click(screen.getByRole("button", { name: "创建管理员" }));

    expect(screen.getByText("密码至少需要 8 位")).toBeInTheDocument();
    expect(screen.getByLabelText("密码")).toHaveAttribute("aria-invalid", "true");
    expect(mocks.apiFetch).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("密码"), "345678");

    expect(screen.queryByText("密码至少需要 8 位")).not.toBeInTheDocument();
  });

  it("uses mobile-friendly autofill and keyboard metadata", () => {
    const { container } = renderSetup();

    const labels = Array.from(container.querySelectorAll("label")).map((label) => label.textContent);
    expect(labels).toEqual(["登录邮箱", "密码", "显示名称"]);
    const emailInput = screen.getByLabelText("登录邮箱");
    const nameInput = screen.getByLabelText("显示名称");
    const passwordInput = screen.getByLabelText("密码");
    expect(emailInput).toHaveAttribute("name", "email");
    expect(emailInput).toHaveAttribute("inputmode", "email");
    expect(emailInput).toHaveAttribute("autocomplete", "email");
    expect(emailInput).toHaveAttribute("enterkeyhint", "next");
    expect(emailInput).toHaveAttribute("autocapitalize", "none");
    expect(emailInput).toHaveAttribute("spellcheck", "false");
    expect(passwordInput).toHaveAttribute("name", "password");
    expect(passwordInput).toHaveAttribute("autocomplete", "new-password");
    expect(passwordInput).toHaveAttribute("enterkeyhint", "next");
    expect(nameInput).toHaveAttribute("name", "name");
    expect(nameInput).toHaveAttribute("autocomplete", "name");
    expect(nameInput).toHaveAttribute("enterkeyhint", "done");
    expect(nameInput).toHaveAttribute("spellcheck", "false");
  });

  it("submits the display name together with the login email", async () => {
    mocks.apiFetch.mockResolvedValue({});
    const user = userEvent.setup();
    renderSetup();

    await user.type(screen.getByLabelText("登录邮箱"), "admin@example.com");
    await user.type(screen.getByLabelText("密码"), "password123");
    await user.clear(screen.getByLabelText("显示名称"));
    await user.type(screen.getByLabelText("显示名称"), "Root Admin");
    await user.click(screen.getByRole("button", { name: "创建管理员" }));

    expect(mocks.apiFetch).toHaveBeenCalledWith("/api/app/setup", expect.anything(), {
      authMode: "none",
      method: "POST",
      body: JSON.stringify({ name: "Root Admin", email: "admin@example.com", password: "password123" }),
    });
  });
});
