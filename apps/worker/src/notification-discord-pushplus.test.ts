import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import type { NotificationEmailMessage } from "@renewlet/shared/email-template";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationChannelError } from "./notification-errors";
import { discordWebhookEndpoint, sendDiscord } from "./notification-discord";
import { NOTIFICATION_HTTP_TIMEOUT_MS, sendNotificationRequest } from "./notification-http";
import { sendPushPlus } from "./notification-pushplus";

const baseMessage: NotificationEmailMessage = {
  title: "Renewlet",
  content: "订阅即将续费",
  timestamp: "2026-06-23 08:00 UTC",
  hasPayload: true,
  items: [],
};

function settings(overrides: Partial<ApiAppSettings>): ApiAppSettings {
  return {
    ...createDefaultAppSettings(),
    timezone: "UTC",
    notificationTimeLocal: "08:00" as ApiAppSettings["notificationTimeLocal"],
    ...overrides,
  };
}

function objectBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("expected JSON string body");
  const parsed = JSON.parse(init.body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected JSON object body");
  return parsed as Record<string, unknown>;
}

const currentDir = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Cloudflare Discord and PushPlus notification senders", () => {
  it("keeps Worker notification channel files behind the shared HTTP boundary", () => {
    for (const file of [
      "notification-channel-send.ts",
      "notification-serverchan.ts",
      "notification-discord.ts",
      "notification-pushplus.ts",
    ]) {
      const source = readFileSync(join(currentDir, file), "utf8");
      expect(source).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("requires official Discord webhook URLs and appends wait=true", () => {
    expect(discordWebhookEndpoint("https://discord.com/api/webhooks/123/token?thread_id=456", "zh-CN")).toBe(
      "https://discord.com/api/webhooks/123/token?thread_id=456&wait=true",
    );
    for (const rawUrl of [
      "http://discord.com/api/webhooks/123/token",
      "https://discordapp.com/api/webhooks/123/token",
      "https://discord.com.evil.example/api/webhooks/123/token",
      "https://discord.com/api/webhooks/123",
    ]) {
      expect(() => discordWebhookEndpoint(rawUrl, "zh-CN")).toThrow();
    }
  });

  it("sends Discord content with wait, allowed_mentions and optional bot identity", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(`{"id":"msg"}`, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendDiscord(settings({
      discordWebhookUrl: "https://discord.com/api/webhooks/123/secret?thread_id=456",
      discordBotUsername: "Renewlet",
      discordBotAvatarUrl: "https://cdn.example.com/avatar.png",
    }), {
      ...baseMessage,
      content: `${"续".repeat(2100)}@everyone`,
    }, "zh-CN");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://discord.com/api/webhooks/123/secret?thread_id=456&wait=true");
    expect(init?.method).toBe("POST");
    const payload = objectBody(init);
    expect(Array.from(String(payload["content"]))).toHaveLength(2000);
    expect(payload["username"]).toBe("Renewlet");
    expect(payload["avatar_url"]).toBe("https://cdn.example.com/avatar.png");
    expect(payload["allowed_mentions"]).toEqual({ parse: [] });
  });

  it("rejects non-public Discord avatar URLs before sending", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendDiscord(settings({
      discordWebhookUrl: "https://discord.com/api/webhooks/123/secret",
      discordBotAvatarUrl: "https://127.0.0.1/avatar.png",
    }), baseMessage, "zh-CN")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("times out hanging Discord requests and keeps webhook secrets out of details", async () => {
    vi.useFakeTimers();
    const abortReasons: unknown[] = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        abortReasons.push(init.signal && "reason" in init.signal ? (init.signal as { reason?: unknown }).reason : null);
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const caughtPromise = sendDiscord(settings({
      discordWebhookUrl: "https://discord.com/api/webhooks/123/discord-secret",
    }), baseMessage, "zh-CN").catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(NOTIFICATION_HTTP_TIMEOUT_MS);
    const caught = await caughtPromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(abortReasons).toHaveLength(1);
    expect(abortReasons[0]).toBeInstanceOf(DOMException);
    expect((abortReasons[0] as DOMException).name).toBe("AbortError");
    expect((abortReasons[0] as DOMException).name).not.toBe("TimeoutError");
    expect(caught).toBeInstanceOf(NotificationChannelError);
    if (caught instanceof NotificationChannelError) {
      expect(caught.message).toContain("timed out after 10s");
      expect(caught.message).not.toContain("discord-secret");
      expect(caught.details?.rawResponseText).toContain("Discord POST request to https://discord.com/api/webhooks/123/[redacted]?wait=true timed out after 10s before response headers");
      expect(caught.details?.rawResponseText).not.toContain("discord-secret");
    }
  });

  it("keeps non-timeout network cause codes without leaking request secrets", async () => {
    const error = new Error("fetch failed for discord-secret");
    Object.assign(error, { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    const fetchMock = vi.fn(async () => {
      throw error;
    });
    vi.stubGlobal("fetch", fetchMock);

    const caught = await sendNotificationRequest(
      "https://discord.com/api/webhooks/123/discord-secret?wait=true",
      { method: "POST", body: "{}" },
      "Discord",
      "zh-CN",
      { secrets: ["discord-secret"] },
    ).catch((caughtError: unknown) => caughtError);

    expect(caught).toBeInstanceOf(NotificationChannelError);
    if (caught instanceof NotificationChannelError) {
      expect(caught.details?.rawResponseText).toBe(
        "Discord POST request to https://discord.com/api/webhooks/123/[redacted]?wait=true failed before response headers: fetch failed for [redacted] (UND_ERR_CONNECT_TIMEOUT); body={}",
      );
      expect(caught.details?.rawResponseText).toContain("[redacted]");
      expect(caught.details?.rawResponseText).not.toContain("discord-secret");
      expect(caught.details?.rawResponseText).toContain("/api/webhooks");
      expect(caught.details?.rawResponseText).toContain("wait=true");
    }
  });

  it("adds public request context to workerd network connection losses", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Network connection lost.");
    });
    vi.stubGlobal("fetch", fetchMock);

    const caught = await sendNotificationRequest(
      "https://discord.com/api/webhooks/123/discord-secret?wait=true",
      { method: "POST", body: "{}" },
      "Discord",
      "zh-CN",
      { secrets: ["discord-secret"] },
    ).catch((caughtError: unknown) => caughtError);

    expect(caught).toBeInstanceOf(NotificationChannelError);
    if (caught instanceof NotificationChannelError) {
      expect(caught.details?.rawResponseText).toBe(
        "Discord POST request to https://discord.com/api/webhooks/123/[redacted]?wait=true failed before response headers: Network connection lost.; body={}",
      );
      expect(caught.details?.rawResponseText).not.toContain("discord-secret");
      expect(caught.details?.rawResponseText).toContain("/api/webhooks");
      expect(caught.details?.rawResponseText).toContain("wait=true");
    }
  });

  it("redacts URL secrets from transport error messages while keeping request shape", async () => {
    const webhookUrl = "https://discord.com/api/webhooks/123/discord-secret?wait=true";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      throw new TypeError(`Network connection lost for ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const caught = await sendNotificationRequest(
      webhookUrl,
      { method: "POST", body: "{}" },
      "Discord",
      "zh-CN",
      { secrets: [] },
    ).catch((caughtError: unknown) => caughtError);

    expect(caught).toBeInstanceOf(NotificationChannelError);
    if (caught instanceof NotificationChannelError) {
      expect(caught.details?.rawResponseText).toBe(
        "Discord POST request to https://discord.com/api/webhooks/123/[redacted]?wait=true failed before response headers: Network connection lost for https://discord.com/api/webhooks/123/[redacted]?wait=true; body={}",
      );
      expect(caught.details?.rawResponseText).not.toContain("discord-secret");
      expect(caught.details?.rawResponseText).toContain("/api/webhooks");
      expect(caught.details?.rawResponseText).toContain("wait=true");
    }
  });

  it("sends PushPlus to the official endpoint and treats code 200 as success", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(`{"code":200,"msg":"ok"}`, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendPushPlus(settings({ pushplusToken: "push-token" }), baseMessage, "zh-CN");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://www.pushplus.plus/send");
    expect(init?.method).toBe("POST");
    expect(objectBody(init)).toEqual({
      token: "push-token",
      title: "Renewlet",
      content: "订阅即将续费\n\n2026-06-23 08:00 UTC",
      template: "txt",
    });
  });

  it("fails PushPlus business errors once and redacts the token", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(`{"code":900,"msg":"push-token invalid"}`, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await sendPushPlus(settings({ pushplusToken: "push-token" }), baseMessage, "zh-CN");
    } catch (error) {
      caught = error;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(caught).toBeInstanceOf(NotificationChannelError);
    if (caught instanceof NotificationChannelError) {
      expect(caught.message).not.toContain("push-token");
      expect(caught.details?.rawResponseText).toContain("[redacted] invalid");
      expect(caught.details?.rawResponseText).not.toContain("push-token");
    }
  });

  it("times out hanging PushPlus requests once and redacts the token", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const caughtPromise = sendPushPlus(settings({ pushplusToken: "push-token" }), baseMessage, "zh-CN")
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(NOTIFICATION_HTTP_TIMEOUT_MS);
    const caught = await caughtPromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(caught).toBeInstanceOf(NotificationChannelError);
    if (caught instanceof NotificationChannelError) {
      expect(caught.message).toContain("timed out after 10s");
      expect(caught.message).not.toContain("push-token");
      expect(caught.details?.rawResponseText).toContain("PushPlus POST request to https://www.pushplus.plus/send timed out after 10s before response headers");
      expect(caught.details?.rawResponseText).not.toContain("push-token");
    }
  });
});
