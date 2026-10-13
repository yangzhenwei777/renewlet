import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpRequest } from "@smithy/core/protocols";
import { CronBudget, CronBudgetExceeded } from "./cron-budget";
import { CronS3HttpHandler } from "./cloud-backup-s3-http";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const request = () => new HttpRequest({ protocol: "https:", hostname: "fixture.test", method: "GET", path: "/object" });

describe("S3 Cron transport budget", () => {
  it("counts every attempted hop and cancels intermediate bodies before using another connection", async () => {
    const budget = new CronBudget();
    const cancel = vi.fn();
    const send = vi.fn().mockImplementationOnce(async () => new Response(new ReadableStream({ cancel }), { status: 307, headers: { location: "/next" } }))
      .mockImplementationOnce(async () => {
        expect(cancel).toHaveBeenCalledOnce();
        return new Response("ok");
      });
    vi.stubGlobal("fetch", send);
    const result = await new CronS3HttpHandler(budget, 0).handle(request());
    expect(await new Response(result.response.body as ReadableStream).text()).toBe("ok");
    expect(budget.used.externalRequests).toBe(2);
  });

  it("stops before request 51 including resources reserved by other providers", async () => {
    const budget = new CronBudget();
    budget.consumeExternal(49);
    const cancel = vi.fn();
    const send = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 307, headers: { location: "/next" } }));
    vi.stubGlobal("fetch", send);
    await expect(new CronS3HttpHandler(budget, 0).handle(request())).rejects.toBeInstanceOf(CronBudgetExceeded);
    expect(send).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(budget.used.externalRequests).toBe(1);
    expect(() => budget.consumeExternal(1)).toThrow(CronBudgetExceeded);
  });

  it("counts a failed network attempt but sends nothing after cancellation", async () => {
    const budget = new CronBudget();
    const send = vi.fn().mockRejectedValue(new TypeError("network"));
    vi.stubGlobal("fetch", send);
    const handler = new CronS3HttpHandler(budget, 0);
    await expect(handler.handle(request())).rejects.toThrow("network");
    await expect(handler.handle(request(), { abortSignal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(send).toHaveBeenCalledOnce();
    expect(budget.used.externalRequests).toBe(1);
  });

  it("keeps one deadline across the complete redirect chain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const budget = new CronBudget();
    const send = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 60);
      return new Response(null, { status: 307, headers: { location: "/next" } });
    });
    vi.stubGlobal("fetch", send);
    await expect(new CronS3HttpHandler(budget, 100).handle(request())).rejects.toMatchObject({ name: "TimeoutError" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(budget.used.externalRequests).toBe(2);
  });

  it.each(["file:///etc/passwd", "https://name:password@fixture.test/next"])("rejects an unsafe redirect target without sending it", async (location) => {
    const send = vi.fn(async () => new Response(null, { status: 307, headers: { location } }));
    vi.stubGlobal("fetch", send);
    await expect(new CronS3HttpHandler(new CronBudget(), 0).handle(request())).rejects.toThrow("Invalid upstream redirect URL");
    expect(send).toHaveBeenCalledOnce();
  });

  it("refuses to replay a consumed stream", async () => {
    const send = vi.fn(async () => new Response(null, { status: 307, headers: { location: "/next" } }));
    vi.stubGlobal("fetch", send);
    await expect(new CronS3HttpHandler(new CronBudget(), 0).handle(new HttpRequest({ ...request(), method: "PUT", body: new ReadableStream() })))
      .rejects.toThrow("Cannot redirect a streaming upstream body");
    expect(send).toHaveBeenCalledOnce();
  });
});
