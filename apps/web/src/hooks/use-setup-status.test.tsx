import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSetupStatus } from "./use-setup-status";

describe("useSetupStatus app status", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads setup and demo capability from the app status endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          setupRequired: false,
          setupEnabled: false,
          demoMode: true,
          turnstile: { enabled: true, siteKey: "site-key" },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSetupStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/app/status", expect.objectContaining({
      cache: "no-store",
      credentials: "include",
    }));
    expect(result.current).toMatchObject({
      setupRequired: false,
      setupEnabled: false,
      demoMode: true,
      turnstile: { enabled: true, siteKey: "site-key" },
    });
  });

  it("falls back to hidden setup and non-demo status when the payload is invalid", async () => {
    // app status 是认证前能力开关；契约异常时测试保守 fallback，避免登录页误显示 setup 入口。
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          setupRequired: true,
          setupEnabled: false,
        },
      }),
    }));

    const { result } = renderHook(() => useSetupStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current).toMatchObject({
      setupRequired: false,
      setupEnabled: true,
      demoMode: false,
      turnstile: { enabled: false, siteKey: "" },
    });
  });
});
