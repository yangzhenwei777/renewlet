// PocketBase 运行时认证测试保护“彻底切换”：Docker 前端也只能走 Renewlet 产品认证 API。
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readProductSession, writeProductSession } from "@/services/product-session";
import type { SessionData } from "./auth-client";

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const mocks = vi.hoisted(() => ({
  authRefresh: vi.fn(),
  authWithPassword: vi.fn(),
  fetch: vi.fn<FetchMock>(),
  pb: {
    authStore: {
      isValid: true,
      record: null as Record<string, unknown> | null,
      token: "pb-token",
      onChange: vi.fn(),
      clear: vi.fn(),
      save: vi.fn(),
    },
    collection: vi.fn(),
  },
}));

vi.mock("@/services/runtime", () => ({
  renewletRuntime: "pocketbase",
  isCloudflareRuntime: false,
}));

vi.mock("@/lib/pocketbase", () => ({
  pb: mocks.pb,
}));

const sessionFixture: SessionData = {
  type: "session",
  session: { expiresAt: "2026-07-03T00:00:00.000Z" },
  user: {
    id: "user-1",
    email: "alice@example.com",
    name: "Alice",
    role: "admin",
    banned: false,
  },
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  return Wrapper;
}

function sessionResponse(session: SessionData) {
  return new Response(JSON.stringify({ ok: true, data: session }), { status: 200 });
}

describe("authClient in PocketBase runtime", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.authRefresh.mockReset();
    mocks.authWithPassword.mockReset();
    mocks.fetch.mockReset();
    mocks.pb.collection.mockReset().mockReturnValue({
      authRefresh: mocks.authRefresh,
      authWithPassword: mocks.authWithPassword,
    });
    window.localStorage.clear();
  });

  it("validates restored product sessions through the product API instead of PocketBase authRefresh", async () => {
    writeProductSession(sessionFixture, { verifiedAt: Date.now() - 120_000 });
    mocks.fetch.mockResolvedValue(sessionResponse(sessionFixture));
    const { authClient } = await import("./auth-client");

    const { result } = renderHook(() => authClient.useSession(), { wrapper: createWrapper() });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0]?.[0]).toBe("/api/app/auth/session");
    expect(mocks.authRefresh).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(result.current.data?.session.expiresAt).toBe("2026-07-03T00:00:00.000Z");
      expect(result.current.isPending).toBe(false);
    });
  });

  it("signs in with the product login endpoint instead of authWithPassword", async () => {
    mocks.fetch.mockResolvedValue(sessionResponse(sessionFixture));
    const { authClient } = await import("./auth-client");

    const result = await authClient.signIn.email({ email: "alice@example.com", password: "password123" });

    expect(result).toMatchObject({ error: null, data: { type: "session", session: { expiresAt: "2026-07-03T00:00:00.000Z" } } });
    expect(mocks.fetch).toHaveBeenCalledWith("/api/app/auth/login", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ email: "alice@example.com", password: "password123" }),
    }));
    expect(mocks.authWithPassword).not.toHaveBeenCalled();
    expect(readProductSession()?.session.expiresAt).toBe("2026-07-03T00:00:00.000Z");
  });

  it("keeps MFA tickets in memory by not writing mfa_required responses to product session storage", async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        type: "mfa_required",
        ticketId: "ticket-1",
        expiresAt: "2026-06-03T00:05:00.000Z",
        methods: ["totp", "recovery_code"],
      },
    }), { status: 200 }));
    const { authClient } = await import("./auth-client");

    const result = await authClient.signIn.email({ email: "alice@example.com", password: "password123" });

    expect(result.data?.type).toBe("mfa_required");
    expect(readProductSession()).toBeNull();
  });

  it("stores the product session only after MFA verification succeeds", async () => {
    mocks.fetch.mockResolvedValue(sessionResponse(sessionFixture));
    const { authClient } = await import("./auth-client");

    const result = await authClient.verifyMfa({ method: "totp", ticketId: "ticket-1", code: "123456" });

    expect(result).toMatchObject({ error: null, data: { session: { expiresAt: "2026-07-03T00:00:00.000Z" } } });
    expect(mocks.fetch).toHaveBeenCalledWith("/api/app/auth/mfa/verify", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ method: "totp", ticketId: "ticket-1", code: "123456" }),
    }));
    expect(readProductSession()?.session.expiresAt).toBe("2026-07-03T00:00:00.000Z");
  });

  it("logs out through the product API and clears product session storage", async () => {
    writeProductSession(sessionFixture);
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 }));
    const { authClient } = await import("./auth-client");

    await authClient.signOut();

    expect(mocks.fetch).toHaveBeenCalledWith("/api/app/auth/logout", {
      method: "POST",
      headers: {},
      credentials: "include",
    });
    expect(readProductSession()).toBeNull();
  });
});
