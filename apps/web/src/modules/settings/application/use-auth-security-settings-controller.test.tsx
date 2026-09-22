// Turnstile 人机验证 controller 测试保护 write-only secret 语义；它是站点级状态，不进入账号 settings 草稿。
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSecuritySettingsController } from "./use-auth-security-settings-controller";

type AppToast = (typeof import("@/components/ui/sonner"))["toast"];

const mocks = vi.hoisted(() => ({
  remote: undefined as unknown,
  mutateAsync: vi.fn(),
  testMutateAsync: vi.fn(),
  toast: {
    success: vi.fn<AppToast["success"]>(),
    error: vi.fn<AppToast["error"]>(),
  },
}));

vi.mock("@/hooks/use-auth-security", () => ({
  useAuthSecuritySettings: (enabled: boolean) => ({
    data: enabled ? mocks.remote : undefined,
    isLoading: false,
  }),
  useUpdateAuthSecuritySettings: () => ({
    mutateAsync: mocks.mutateAsync,
    isPending: false,
  }),
  useTestAuthSecurityTurnstile: () => ({
    mutateAsync: mocks.testMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: mocks.toast,
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

describe("useAuthSecuritySettingsController", () => {
  beforeEach(() => {
    mocks.remote = {
      turnstile: { enabled: true, siteKey: "site-key", secretConfigured: true },
    };
    mocks.mutateAsync.mockReset().mockResolvedValue({
      turnstile: { enabled: true, siteKey: "site-key", secretConfigured: true },
    });
    mocks.testMutateAsync.mockReset().mockResolvedValue({ verified: true });
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
  });

  it("saves a new Turnstile secret only when the draft contains one", async () => {
    const { result } = renderHook(() => useAuthSecuritySettingsController(true, false));

    await waitFor(() => expect(result.current.draft.siteKey).toBe("site-key"));
    act(() => {
      result.current.setSecret(" new-secret ");
    });
    await waitFor(() => expect(result.current.draft.secret).toBe(" new-secret "));
    await act(async () => {
      await result.current.save();
    });

    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      turnstile: { enabled: true, siteKey: "site-key", secret: "new-secret" },
    });
  });

  it("omits Turnstile secret to keep the stored value", async () => {
    const { result } = renderHook(() => useAuthSecuritySettingsController(true, false));

    await waitFor(() => expect(result.current.draft.siteKey).toBe("site-key"));
    act(() => {
      result.current.setSiteKey("site-key-2");
    });
    await waitFor(() => expect(result.current.draft.siteKey).toBe("site-key-2"));
    await act(async () => {
      await result.current.save();
    });

    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      turnstile: { enabled: true, siteKey: "site-key-2" },
    });
  });

  it("clears the Turnstile secret by sending an explicit empty string", async () => {
    mocks.mutateAsync.mockResolvedValueOnce({
      turnstile: { enabled: false, siteKey: "site-key", secretConfigured: false },
    });
    const { result } = renderHook(() => useAuthSecuritySettingsController(true, false));

    await waitFor(() => expect(result.current.secretConfigured).toBe(true));
    await act(async () => {
      await result.current.clearSecret();
    });

    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      turnstile: { enabled: false, siteKey: "site-key", secret: "" },
    });
    expect(result.current.secretConfigured).toBe(false);
  });

  it("tests the current draft Turnstile secret without saving it", async () => {
    const { result } = renderHook(() => useAuthSecuritySettingsController(true, false));

    await waitFor(() => expect(result.current.draft.siteKey).toBe("site-key"));
    act(() => {
      result.current.setSecret(" new-secret ");
    });
    act(() => {
      result.current.startTest();
    });

    expect(result.current.testDialogOpen).toBe(true);
    expect(result.current.testDialogSiteKey).toBe("site-key");

    act(() => {
      result.current.handleTestTokenChange(" token-value ");
    });

    await waitFor(() => expect(mocks.testMutateAsync).toHaveBeenCalledWith({
      turnstile: { siteKey: "site-key", secret: "new-secret", turnstileToken: "token-value" },
    }));
    await waitFor(() => expect(result.current.testDialogOpen).toBe(false));
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
    expect(mocks.toast.success).toHaveBeenCalledWith("settings.turnstileTestPassed");
  });

  it("omits the Turnstile test secret to let the server use the stored value", async () => {
    const { result } = renderHook(() => useAuthSecuritySettingsController(true, false));

    await waitFor(() => expect(result.current.secretConfigured).toBe(true));
    act(() => {
      result.current.startTest();
    });
    act(() => {
      result.current.handleTestTokenChange("stored-token");
    });

    await waitFor(() => expect(mocks.testMutateAsync).toHaveBeenCalledWith({
      turnstile: { siteKey: "site-key", turnstileToken: "stored-token" },
    }));
  });

  it("rejects incomplete Turnstile tests before rendering the widget", async () => {
    mocks.remote = {
      turnstile: { enabled: false, siteKey: "", secretConfigured: false },
    };
    const { result } = renderHook(() => useAuthSecuritySettingsController(true, false));

    await waitFor(() => expect(result.current.draft.siteKey).toBe(""));
    act(() => {
      result.current.startTest();
    });

    expect(result.current.testDialogOpen).toBe(false);
    expect(mocks.testMutateAsync).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith("settings.turnstileTestFailed", {
      description: "settings.turnstileIncomplete",
    });
  });

  it("resets the Turnstile test widget after a failed Siteverify call", async () => {
    mocks.testMutateAsync.mockRejectedValueOnce(new Error("test failed"));
    const { result } = renderHook(() => useAuthSecuritySettingsController(true, false));

    await waitFor(() => expect(result.current.draft.siteKey).toBe("site-key"));
    act(() => {
      result.current.setSecret("secret-value");
    });
    act(() => {
      result.current.startTest();
    });
    const resetSignal = result.current.testResetSignal;
    act(() => {
      result.current.handleTestTokenChange("bad-token");
    });

    await waitFor(() => expect(result.current.testError).toBe("test failed"));
    expect(result.current.testDialogOpen).toBe(true);
    expect(result.current.testResetSignal).toBeGreaterThan(resetSignal);
    expect(mocks.toast.error).toHaveBeenCalledWith("settings.turnstileTestFailed", {
      description: "test failed",
    });
  });

  it("keeps stale Siteverify results from reopening a closed test dialog", async () => {
    let rejectTest: ((error: Error) => void) | undefined;
    mocks.testMutateAsync.mockReturnValueOnce(new Promise((_, reject) => {
      rejectTest = reject;
    }));
    const { result } = renderHook(() => useAuthSecuritySettingsController(true, false));

    await waitFor(() => expect(result.current.draft.siteKey).toBe("site-key"));
    act(() => {
      result.current.setSecret("secret-value");
    });
    act(() => {
      result.current.startTest();
    });
    act(() => {
      result.current.handleTestTokenChange("token-value");
    });

    expect(result.current.testDialogOpen).toBe(true);

    act(() => {
      result.current.handleTestDialogOpenChange(false);
    });
    expect(result.current.testDialogOpen).toBe(false);

    await act(async () => {
      rejectTest?.(new Error("late failure"));
      await Promise.resolve();
    });

    expect(result.current.testDialogOpen).toBe(false);
    expect(result.current.testError).toBeUndefined();
    expect(mocks.toast.error).not.toHaveBeenCalledWith("settings.turnstileTestFailed", {
      description: "late failure",
    });
  });
});
