// 登录 Turnstile 测试只 fake 第三方 widget；页面状态链、表单校验和 auth client 提交仍走 Login 本体。
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import Login from "./login";

const mocks = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  signInPasskey: vi.fn(),
  verifyMfa: vi.fn(),
  cancelPasskeyCeremony: vi.fn(),
  reportClientError: vi.fn(),
  usePasswordResetAvailability: vi.fn(),
  useSetupStatus: vi.fn(),
  setTheme: vi.fn(),
  resolvedTheme: "dark" as "light" | "dark",
}));

vi.mock("@/components/turnstile-widget", () => ({
  TurnstileWidget: ({
    siteKey,
    theme,
    resetSignal,
    error,
    onTokenChange,
  }: {
    siteKey: string;
    theme: "light" | "dark";
    resetSignal: number;
    error?: string;
    onTokenChange: (token: string) => void;
  }) => (
    <div data-testid="turnstile-widget" data-site-key={siteKey} data-theme={theme} data-reset-signal={resetSignal}>
      <button type="button" onClick={() => onTokenChange("turnstile-token")}>Complete verification</button>
      {error ? <p>{error}</p> : null}
    </div>
  ),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: {
      email: mocks.signInEmail,
      passkey: mocks.signInPasskey,
    },
    verifyMfa: mocks.verifyMfa,
    cancelPasskeyCeremony: mocks.cancelPasskeyCeremony,
  },
}));

vi.mock("@/hooks/use-password-reset-availability", () => ({
  usePasswordResetAvailability: mocks.usePasswordResetAvailability,
}));

vi.mock("@/lib/report-client-error", () => ({
  reportClientError: mocks.reportClientError,
}));

vi.mock("@/hooks/use-setup-status", () => ({
  useSetupStatus: mocks.useSetupStatus,
}));

vi.mock("@/lib/theme-provider", () => ({
  useTheme: () => ({
    theme: mocks.resolvedTheme,
    resolvedTheme: mocks.resolvedTheme,
    setTheme: mocks.setTheme,
  }),
}));

function renderLogin() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  );
}

function emailInput() {
  const input = document.getElementById("login-email");
  if (!(input instanceof HTMLInputElement)) throw new Error("Expected login email input");
  return input;
}

function passwordInput() {
  const input = document.getElementById("login-password");
  if (!(input instanceof HTMLInputElement)) throw new Error("Expected login password input");
  return input;
}

function loginButton() {
  const button = screen
    .getAllByRole("button", { name: /Log in|登录/ })
    .find((candidate) => candidate.getAttribute("type") === "submit");
  if (!button) throw new Error("Expected login submit button");
  return button;
}

describe("Login page Turnstile protection", () => {
  beforeEach(() => {
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      value: {
        isConditionalMediationAvailable: vi.fn().mockResolvedValue(false),
      },
    });
    Element.prototype.scrollIntoView = vi.fn();
    mocks.signInEmail.mockReset().mockResolvedValue({ error: null });
    mocks.signInPasskey.mockReset().mockResolvedValue({ error: null, cancelled: false });
    mocks.verifyMfa.mockReset().mockResolvedValue({ error: null });
    mocks.cancelPasskeyCeremony.mockReset();
    mocks.reportClientError.mockReset();
    mocks.setTheme.mockReset();
    mocks.resolvedTheme = "dark";
    mocks.usePasswordResetAvailability.mockReturnValue(false);
    mocks.useSetupStatus.mockReturnValue({
      setupRequired: false,
      setupEnabled: true,
      demoMode: false,
      turnstile: { enabled: false, siteKey: "" },
      isLoading: false,
    });
  });

  it("does not render the widget when Turnstile is disabled", () => {
    renderLogin();

    expect(screen.queryByTestId("turnstile-widget")).not.toBeInTheDocument();
  });

  it("submits the Turnstile token together with email password login", async () => {
    const user = userEvent.setup();
    mocks.useSetupStatus.mockReturnValue({
      setupRequired: false,
      setupEnabled: true,
      demoMode: false,
      turnstile: { enabled: true, siteKey: "site-key" },
      isLoading: false,
    });
    renderLogin();

    expect(screen.getByTestId("turnstile-widget")).toHaveAttribute("data-site-key", "site-key");
    expect(screen.getByTestId("turnstile-widget")).toHaveAttribute("data-theme", "dark");
    await user.type(emailInput(), "alice@example.com");
    await user.type(passwordInput(), "password123");
    await user.click(loginButton());

    expect(mocks.signInEmail).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Complete verification" }));
    await user.click(loginButton());

    await waitFor(() => {
      expect(mocks.signInEmail).toHaveBeenCalledWith({
        email: "alice@example.com",
        password: "password123",
        turnstileToken: "turnstile-token",
      });
    });
  });

  it("passes the resolved light theme into the Turnstile widget", () => {
    mocks.resolvedTheme = "light";
    mocks.useSetupStatus.mockReturnValue({
      setupRequired: false,
      setupEnabled: true,
      demoMode: false,
      turnstile: { enabled: true, siteKey: "site-key" },
      isLoading: false,
    });

    renderLogin();

    expect(screen.getByTestId("turnstile-widget")).toHaveAttribute("data-theme", "light");
  });

  it("resets the widget after a failed email password login", async () => {
    const user = userEvent.setup();
    mocks.useSetupStatus.mockReturnValue({
      setupRequired: false,
      setupEnabled: true,
      demoMode: false,
      turnstile: { enabled: true, siteKey: "site-key" },
      isLoading: false,
    });
    mocks.signInEmail.mockResolvedValueOnce({ error: new Error("invalid credentials") });
    renderLogin();

    await user.type(emailInput(), "alice@example.com");
    await user.type(passwordInput(), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Complete verification" }));
    await user.click(loginButton());

    await waitFor(() => {
      expect(screen.getByTestId("turnstile-widget")).toHaveAttribute("data-reset-signal", "1");
    });
  });
});
