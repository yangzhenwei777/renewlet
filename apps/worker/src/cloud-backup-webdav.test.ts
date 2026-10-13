import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerWebDAVClient } from "./cloud-backup-webdav";
import { CronBudget, CronBudgetExceeded } from "./cron-budget";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function client(budget?: CronBudget, timeoutMs = 1_000) {
  return new WorkerWebDAVClient({ baseURL: "https://dav.example.test/", username: "fixture-user", password: "fixture-password", budget, timeoutMs });
}

describe("WebDAV operation budgets", () => {
  it.each([0, 1, 10, 15, 16, 20])("counts Digest exchanges and each of %i redirects", async (redirects) => {
    const budget = new CronBudget();
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      const hop = (fetch.mock.calls.length - 1) % (redirects + 1);
      if (hop < redirects) return new Response(null, { status: 307, headers: { location: "https://dav.example.test/file" } });
      if (!new Headers(init?.headers).get("authorization")?.startsWith("Digest ")) {
        return new Response(null, { status: 401, headers: { "www-authenticate": 'Digest realm="fixture", nonce="fixture-nonce", qop="auth", algorithm=MD5' } });
      }
      return new Response("fixture");
    });
    vi.stubGlobal("fetch", fetch);
    if (redirects < 16) expect(new TextDecoder().decode(await client(budget).get("file"))).toBe("fixture");
    else await expect(client(budget).get("file")).rejects.toBeInstanceOf(CronBudgetExceeded);
    expect(budget.used.externalRequests).toBe(Math.min(3 * (redirects + 1), 50));
    expect(fetch).toHaveBeenCalledTimes(budget.used.externalRequests);
    expect(budget.used.externalReserved).toBe(0);
  });

  it("isolates concurrent clients and manual requests while completions interleave", async () => {
    const budgets = [new CronBudget(), new CronBudget()];
    const first = budgets[0]; const second = budgets[1];
    if (!first || !second) throw new Error("Missing fixture budgets");
    first.consumeExternal(49);
    const releases = new Map<string, () => void>();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (!url.search) {
        await new Promise<void>((resolve) => releases.set(url.pathname, resolve));
        if (url.pathname === "/manual") {
          expect(init?.redirect).toBeUndefined();
          return new Response("manual-ok");
        }
        return new Response(null, { status: 307, headers: { location: url.href + "?final=1" } });
      }
      expect(init?.redirect).toBe("manual");
      return new Response(url.pathname);
    }));
    const a = client(first).get("a");
    const aFailure = expect(a).rejects.toBeInstanceOf(CronBudgetExceeded);
    const b = client(second).get("b");
    // 未传budget的手动操作仍使用原生fetch；stub直接返回终态，以免伪造浏览器的自动跳转。
    const manual = new WorkerWebDAVClient({ baseURL: "https://dav.example.test/", username: "", password: "" });
    const m = manual.get("manual");
    expect([...releases.keys()]).toEqual(["/a", "/b", "/manual"]);
    releases.get("/b")?.();
    expect(new TextDecoder().decode(await b)).toBe("/b");
    releases.get("/a")?.();
    await aFailure;
    releases.get("/manual")?.();
    expect(new TextDecoder().decode(await m)).toBe("manual-ok");
    expect(calls).toEqual(["/a", "/b", "/manual", "/b"]);
    expect(first.used.externalRequests).toBe(1);
    expect(second.used.externalRequests).toBe(2);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("manual-ok")));
    expect(new TextDecoder().decode(await manual.get("manual"))).toBe("manual-ok");
    expect(first.used.externalRequests).toBe(1);
    expect(second.used.externalRequests).toBe(2);
  });

  it("keeps the timeout across the entire authentication operation", async () => {
    vi.useFakeTimers();
    const budget = new CronBudget();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return new Response(null, { status: 401, headers: { "www-authenticate": 'Digest realm="fixture", nonce="nonce", qop="auth"' } });
      }
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }));
    const result = expect(client(budget, 100).get("file")).rejects.toMatchObject({ timedOut: true });
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(calls).toBe(2);
    expect(budget.used.externalRequests).toBe(2);
  });

  it("never starts a request once the shared invocation budget is exhausted", async () => {
    const budget = new CronBudget(); budget.consumeExternal(50);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(client(budget).get("file")).rejects.toBeInstanceOf(CronBudgetExceeded);
    expect(fetch).not.toHaveBeenCalled();
  });
});
