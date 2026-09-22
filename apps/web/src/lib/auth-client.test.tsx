// auth-client 测试保护 Cloudflare session single-flight、本地缓存新鲜度和失效清理，避免会话风暴或旧 token 复活。
import { StrictMode, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProductSession, writeProductSession } from "@/services/product-session";
import type { SessionData } from "./auth-client";
import { authClient, initializeProductSessionQuery } from "./auth-client";

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<FetchMock>(),
  authStoreOnChange: vi.fn(),
  authStoreClear: vi.fn(),
  authenticatePasskey: vi.fn(),
  cancelActivePasskeyCeremony: vi.fn(),
}));

vi.mock("@/services/runtime", () => ({
  renewletRuntime: "cloudflare",
  isCloudflareRuntime: true,
}));

vi.mock("@/lib/pocketbase", () => ({
  pb: {
    authStore: {
      isValid: false,
      record: null,
      token: "",
      onChange: mocks.authStoreOnChange,
      clear: mocks.authStoreClear,
    },
    collection: vi.fn(),
  },
}));

vi.mock("@/services/passkey-service", () => ({
  passkeyService: {
    authenticate: mocks.authenticatePasskey,
    cancelActiveCeremony: mocks.cancelActivePasskeyCeremony,
  },
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

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createWrapper(queryClient = createTestQueryClient()) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  return Wrapper;
}

const applicationQueryDisposers = new Set<() => void>();

function SessionState() {
  const { data, isPending } = authClient.useSession();
  return <div role="status" aria-label="session state">{isPending ? "pending" : data?.user.id ?? "anonymous"}</div>;
}

function renderSessionApp() {
  const queryClient = createTestQueryClient();
  const disposeQuery = initializeProductSessionQuery(queryClient);
  applicationQueryDisposers.add(disposeQuery);

  const rendered = render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <SessionState />
      </QueryClientProvider>
    </StrictMode>,
  );

  return {
    ...rendered,
    disposeQuery() {
      applicationQueryDisposers.delete(disposeQuery);
      disposeQuery();
    },
  };
}

afterEach(() => {
  for (const dispose of applicationQueryDisposers) dispose();
  applicationQueryDisposers.clear();
});

function sessionResponse(session: SessionData) {
  return new Response(JSON.stringify({ ok: true, data: session }), { status: 200 });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function useTwoSessions() {
  const first = authClient.useSession();
  const second = authClient.useSession();
  return { first, second };
}

describe("authClient.useSession", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.fetch.mockReset();
    mocks.authStoreOnChange.mockReset();
    mocks.authStoreClear.mockReset();
    mocks.authenticatePasskey.mockReset().mockResolvedValue({ status: "authenticated", session: sessionFixture });
    mocks.cancelActivePasskeyCeremony.mockReset();
    window.localStorage.clear();
  });

  it("deduplicates simultaneous Cloudflare session validation across consumers", async () => {
    writeProductSession(sessionFixture, { verifiedAt: Date.now() - 120_000 });
    const deferred = createDeferred<Response>();
    mocks.fetch.mockImplementation(() => deferred.promise);

    const { result } = renderHook(() => useTwoSessions(), { wrapper: createWrapper() });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    deferred.resolve(sessionResponse(sessionFixture));

    await waitFor(() => {
      expect(result.current.first.isPending).toBe(false);
      expect(result.current.second.isPending).toBe(false);
    });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [input, init] = mocks.fetch.mock.calls[0]!;
    const headers = init?.headers;
    expect(input).toBe("/api/app/auth/session");
    expect(init?.credentials).toBe("include");
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBeNull();
    expect(result.current.first.data?.user.email).toBe("alice@example.com");
    expect(result.current.second.data?.user.email).toBe("alice@example.com");
  });

  it("keeps a verified Cloudflare session fresh across route remounts and page reloads", async () => {
    act(() => writeProductSession(sessionFixture));
    mocks.fetch.mockImplementation(() => Promise.resolve(sessionResponse(sessionFixture)));

    const firstRender = renderHook(() => authClient.useSession(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(firstRender.result.current.isPending).toBe(false);
    });
    expect(mocks.fetch).not.toHaveBeenCalled();

    firstRender.unmount();
    const secondRender = renderHook(() => authClient.useSession(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(secondRender.result.current.isPending).toBe(false);
    });
    expect(secondRender.result.current.data?.session.expiresAt).toBe("2026-07-03T00:00:00.000Z");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("hydrates a login event into existing consumers without validating session again", async () => {
    renderSessionApp();

    expect(screen.getByRole("status", { name: "session state" })).toHaveTextContent("anonymous");

    act(() => writeProductSession(sessionFixture));

    await waitFor(() => {
      expect(screen.getByRole("status", { name: "session state" })).toHaveTextContent("user-1");
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("stores the product session after passkey sign-in succeeds", async () => {
    const result = await authClient.signIn.passkey();

    expect(result).toMatchObject({ error: null, cancelled: false, data: { type: "session", session: { expiresAt: "2026-07-03T00:00:00.000Z" } } });
    expect(mocks.authenticatePasskey).toHaveBeenCalledTimes(1);
    expect(readProductSession()?.session.expiresAt).toBe("2026-07-03T00:00:00.000Z");
  });

  it("does not persist a session when passkey sign-in is cancelled", async () => {
    mocks.authenticatePasskey.mockResolvedValueOnce({ status: "cancelled" });

    const result = await authClient.signIn.passkey();

    expect(result).toEqual({ data: null, error: null, cancelled: true });
    expect(readProductSession()).toBeNull();
  });

  it("returns real passkey sign-in errors without persisting a session", async () => {
    const error = new Error("RP ID mismatch");
    mocks.authenticatePasskey.mockRejectedValueOnce(error);

    const result = await authClient.signIn.passkey();

    expect(result).toEqual({ data: null, error, cancelled: false });
    expect(readProductSession()).toBeNull();
  });

  it("allows stale conditional passkey sessions to be ignored before persistence", async () => {
    const result = await authClient.signIn.passkey({
      useBrowserAutofill: true,
      shouldPersistSession: () => false,
    });

    expect(result).toMatchObject({ error: null, cancelled: false, data: { type: "session", session: { expiresAt: "2026-07-03T00:00:00.000Z" } } });
    expect(mocks.authenticatePasskey).toHaveBeenCalledWith({ useBrowserAutofill: true });
    expect(readProductSession()).toBeNull();
  });

  it("delegates browser WebAuthn ceremony cancellation to the passkey service", () => {
    authClient.cancelPasskeyCeremony();

    expect(mocks.cancelActivePasskeyCeremony).toHaveBeenCalledTimes(1);
    expect(readProductSession()).toBeNull();
  });

  it("allows stale MFA verification sessions to be ignored before persistence", async () => {
    mocks.fetch.mockResolvedValueOnce(sessionResponse(sessionFixture));

    const result = await authClient.verifyMfa(
      { method: "totp", ticketId: "ticket-1", code: "123456" },
      { shouldPersistSession: () => false },
    );

    expect(result).toMatchObject({ error: null, data: { type: "session", session: { expiresAt: "2026-07-03T00:00:00.000Z" } } });
    expect(mocks.fetch).toHaveBeenCalledWith("/api/app/auth/mfa/verify", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ method: "totp", ticketId: "ticket-1", code: "123456" }),
    }));
    expect(readProductSession()).toBeNull();
  });

  it("keeps one stale validation request across StrictMode remounts", async () => {
    writeProductSession(sessionFixture, { verifiedAt: Date.now() - 120_000 });
    const deferred = createDeferred<Response>();
    let requestSignal: AbortSignal | undefined;
    mocks.fetch.mockImplementation((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return deferred.promise;
    });

    renderSessionApp();

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(false);
    expect(screen.getByRole("status", { name: "session state" })).toHaveTextContent("pending");
    deferred.resolve(sessionResponse(sessionFixture));

    await waitFor(() => {
      expect(screen.getByRole("status", { name: "session state" })).toHaveTextContent("user-1");
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("only aborts stale validation when the application query owner is disposed", () => {
    writeProductSession(sessionFixture, { verifiedAt: Date.now() - 120_000 });
    let requestSignal: AbortSignal | undefined;
    mocks.fetch.mockImplementation((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }, { once: true });
      });
    });

    const rendered = renderSessionApp();
    expect(requestSignal?.aborted).toBe(false);
    rendered.unmount();

    expect(requestSignal?.aborted).toBe(false);
    rendered.disposeQuery();
    expect(requestSignal?.aborted).toBe(true);
    expect(readProductSession()?.user.id).toBe("user-1");
  });

  it("does not let a late validation response overwrite a newer login", async () => {
    writeProductSession(sessionFixture, { verifiedAt: Date.now() - 120_000 });
    const deferred = createDeferred<Response>();
    mocks.fetch.mockImplementation(() => deferred.promise);
    const nextSession: SessionData = {
      ...sessionFixture,
      session: { expiresAt: "2026-08-03T00:00:00.000Z" },
      user: { ...sessionFixture.user, id: "user-2", email: "bob@example.com" },
    };
    renderSessionApp();

    act(() => writeProductSession(nextSession));
    deferred.resolve(sessionResponse(sessionFixture));

    await waitFor(() => {
      expect(screen.getByRole("status", { name: "session state" })).toHaveTextContent("user-2");
    });
    expect(readProductSession()?.user.id).toBe("user-2");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
