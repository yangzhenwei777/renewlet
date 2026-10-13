import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import { CronBudget, CronBudgetExceeded } from "./cron-budget";
import { sendChannel } from "./notification-channel-send";
import { sendNotificationRequest } from "./notification-http";
import { sendUpstreamRequest } from "./upstream-http";
import { assertSafeOutboundUrl } from "./outbound-url-policy";
import type { Env } from "./types";

vi.mock("./smtp", () => ({ notificationSmtpConfig: vi.fn(), sendSmtpEmail: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const message = { title: "Reminder", content: "Test", timestamp: "08:00", hasPayload: true, items: [] };
const env = { DB: {} as D1Database, ASSETS: {} as Fetcher, ASSETS_BUCKET: {} as R2Bucket } satisfies Env;

describe("notification transport request accounting", () => {
  it.each(["webhook", "bark", "wechat", "dingtalk"] as const)("counts both DoH requests and all delivery redirects for %s", async (channel) => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); calls.push(url.toString());
      if (url.hostname === "cloudflare-dns.com") return Response.json({ Answer: [{ data: "93.184.216.34" }] });
      const hop = Number(url.searchParams.get("hop") ?? 0);
      url.searchParams.set("hop", String(hop + 1));
      return hop < 20 ? new Response(null, { status: 307, headers: { location: url.href } }) : Response.json({ errcode: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const budget = new CronBudget();
    await sendChannel(env, channel, { ...createDefaultAppSettings(), webhookUrl: "https://notify.example/send", barkServerUrl: "https://notify.example", barkDeviceKey: "fixture-device", wechatWebhookUrl: "https://notify.example/send", dingtalkWebhookUrl: "https://notify.example/send" }, message, "en-US", undefined, budget);
    expect(budget.used).toMatchObject({ externalRequests: 23, externalReserved: 0 });
    expect(calls.filter((url) => url.includes("cloudflare-dns.com"))).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(23);
  });

  it.each(["telegram", "notifyx", "serverchan", "discord", "pushplus"] as const)("counts the fixed-provider request for %s", async (channel) => {
    const fetchMock = vi.fn(async () => Response.json({ code: channel === "pushplus" ? 200 : 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const budget = new CronBudget();
    await sendChannel(env, channel, { ...createDefaultAppSettings(), telegramBotToken: "fixture-token", telegramChatId: "fixture-chat", notifyxApiKey: "fixture-key", serverchanSendKey: "SCTfixture", discordWebhookUrl: "https://discord.com/api/webhooks/123/fixture", pushplusToken: "fixture-token" }, message, "en-US", undefined, budget);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(budget.used).toMatchObject({ externalRequests: 1, externalReserved: 0 });
  });

  it("keeps SMTP reservations distinct from measured HTTP requests", async () => {
    const budget = new CronBudget();
    await sendChannel(env, "email", { ...createDefaultAppSettings(), recipientEmail: "fixture@example.test" }, message, "en-US", undefined, budget);
    expect(budget.used).toMatchObject({ externalRequests: 0, externalReserved: 3 });
  });

  it("drains parallel DoH requests and stops a single-channel chain at the shared limit", async () => {
    let inFlight = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      inFlight++;
      await Promise.resolve();
      const url = new URL(String(input));
      const hop = Number(url.searchParams.get("hop") ?? 0);
      url.searchParams.set("hop", String(hop + 1));
      inFlight--;
      if (hop < 20) return new Response(null, { status: 307, headers: { location: url.href } });
      return Response.json({ Answer: [{ data: "93.184.216.34" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const budget = new CronBudget();
    await expect(sendChannel(env, "webhook", { ...createDefaultAppSettings(), webhookUrl: "https://notify.example/send" }, message, "en-US", undefined, budget)).rejects.toBeInstanceOf(CronBudgetExceeded);
    expect(fetchMock).toHaveBeenCalledTimes(50);
    expect(budget.used.externalRequests).toBe(50);
    expect(inFlight).toBe(0);
    const depleted = new CronBudget(); depleted.consumeExternal(49);
    fetchMock.mockClear();
    await expect(assertSafeOutboundUrl("https://notify.example/send", "en-US", undefined, depleted)).rejects.toBeInstanceOf(CronBudgetExceeded);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inFlight).toBe(0);
  });

  it("preserves budget errors at the notification boundary and cancels intermediate bodies", async () => {
    const cancelled = vi.fn();
    const send = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }), { status: 307, headers: { location: "/again" } }));
    vi.stubGlobal("fetch", send);
    const budget = new CronBudget(); budget.consumeExternal(49);
    await expect(sendNotificationRequest("https://example.com", { method: "POST", body: "test" }, "fixture", "en-US", { budget })).rejects.toBeInstanceOf(CronBudgetExceeded);
    expect(send).toHaveBeenCalledOnce(); expect(cancelled).toHaveBeenCalledOnce();
  });

  it("uses a single timeout across the redirect chain and sends nothing after cancellation", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      calls++;
      const timer = setTimeout(() => { resolve(new Response(null, { status: 307, headers: { location: "/again" } })); }, 60);
      init.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    }));
    const budget = new CronBudget();
    const result = expect(sendUpstreamRequest("https://example.com", {}, { provider: "fixture", budget, timeoutMs: 100 })).rejects.toMatchObject({ timedOut: true });
    await vi.advanceTimersByTimeAsync(100); await result;
    expect(calls).toBe(2); expect(budget.used.externalRequests).toBe(2);
    const aborted = new AbortController(); aborted.abort();
    await expect(sendUpstreamRequest("https://example.com", { signal: aborted.signal }, { provider: "fixture", budget })).rejects.toMatchObject({ timedOut: false });
    expect(calls).toBe(2);
  });

  it("uses Request header replacement and inherited cancellation when a budget is present", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init: RequestInit) => {
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      return new Response(null);
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("https://example.com", { headers: { authorization: "fixture" } });
    await sendUpstreamRequest(request, { headers: { accept: "text/plain" } }, { provider: "fixture", budget: new CronBudget() });
    expect(fetchMock).toHaveBeenCalledOnce();
    const abort = new AbortController(); abort.abort();
    await expect(sendUpstreamRequest(new Request("https://example.com", { signal: abort.signal }), {}, { provider: "fixture", budget: new CronBudget() })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["manual", "error"] as const)("honors explicit redirect mode %s without an extra hop", async (redirect) => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 307, headers: { location: "/again" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = sendUpstreamRequest("https://example.com", { redirect }, { provider: "fixture", budget: new CronBudget() });
    if (redirect === "manual") expect((await result).status).toBe(307);
    else await expect(result).rejects.toThrow("redirect disallowed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
