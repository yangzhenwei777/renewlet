import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const fetchMock = vi.fn<FetchMock>();

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  vi.stubEnv("VITE_POCKETBASE_URL", "");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation(async () => new Response(null, { status: 204 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function loadService() {
  const locale = await import("@/i18n/api-locale");
  locale.setApiLocale("en-US");
  const { passwordResetService } = await import("./password-reset-service");
  return { passwordResetService, setApiLocale: locale.setApiLocale };
}

describe("native password reset transport", () => {
  it("preserves the native endpoint, JSON body and both committed locale headers", async () => {
    const { passwordResetService, setApiLocale } = await loadService();
    await passwordResetService.request("alice@example.com");
    expect(fetchMock).toHaveBeenNthCalledWith(1, `${window.location.origin}/api/collections/users/request-password-reset`, expect.objectContaining({
      method: "POST", body: JSON.stringify({ email: "alice@example.com" }),
    }));
    const requestHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get("Content-Type")).toBe("application/json");
    expect(requestHeaders.get("Accept-Language")).toBe("en-US");
    expect(requestHeaders.get("X-Renewlet-Locale")).toBe("en-US");

    setApiLocale("zh-CN");
    await passwordResetService.confirm("reset-token", "new-password");
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${window.location.origin}/api/collections/users/confirm-password-reset`, expect.objectContaining({
      method: "POST", body: JSON.stringify({ token: "reset-token", password: "new-password", passwordConfirm: "new-password" }),
    }));
    const confirmHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(confirmHeaders.get("Accept-Language")).toBe("zh-CN");
    expect(confirmHeaders.get("X-Renewlet-Locale")).toBe("zh-CN");
    expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toBeInstanceOf(Headers);
  });

  it("keeps the configured PocketBase base path", async () => {
    vi.stubEnv("VITE_POCKETBASE_URL", "https://api.example.test/backend/");
    const { passwordResetService } = await loadService();
    await passwordResetService.request("alice@example.com");
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.test/backend/api/collections/users/request-password-reset", expect.anything());
  });

  it("does not let concurrent reset requests abort one another", async () => {
    const finish: Array<() => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => {
      finish.push(() => resolve(new Response(null, { status: 204 })));
    }));
    const { passwordResetService } = await loadService();
    const first = passwordResetService.request("alice@example.com");
    const second = passwordResetService.request("bob@example.com");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    for (const [, options] of fetchMock.mock.calls) expect(options?.signal?.aborted ?? false).toBe(false);
    for (const resolve of finish) resolve();
    await Promise.all([first, second]);
  });

  it("preserves the SDK error response for existing reset feedback", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "Invalid or expired reset token", data: { token: { code: "validation_invalid_token" } } }), { status: 400 }));
    const { passwordResetService } = await loadService();
    await expect(passwordResetService.confirm("expired", "new-password")).rejects.toMatchObject({
      status: 400,
      response: { message: "Invalid or expired reset token", data: { token: { code: "validation_invalid_token" } } },
    });
  });
});
