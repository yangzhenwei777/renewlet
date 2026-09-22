import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { notificationTest } from "./notifications";
import { NOTIFICATION_HTTP_TIMEOUT_MS } from "./notification-http";
import type { Env } from "./types";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

vi.mock("./smtp", () => ({
  notificationSmtpConfig: () => {
    throw new Error("SMTP should not be used by notification test endpoint tests");
  },
  sendSmtpEmail: async () => undefined,
}));

type FakeD1Query = {
  sql: string;
  params: unknown[];
  method: "all" | "first" | "run";
};

function fakeEnv(handler: (query: FakeD1Query) => unknown | Promise<unknown>): Env {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              all: async () => await handler({ sql, params, method: "all" }),
              first: async () => await handler({ sql, params, method: "first" }),
              run: async () => await handler({ sql, params, method: "run" }),
            } as D1PreparedStatement;
          },
        } as D1PreparedStatement;
      },
    } as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
  };
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function settings(overrides: Partial<ApiAppSettings> = {}): ApiAppSettings {
  return {
    ...createDefaultAppSettings(),
    timezone: "UTC",
    notificationTimeLocal: "08:00" as ApiAppSettings["notificationTimeLocal"],
    ...overrides,
  };
}

function settingsEnv(): Env {
  return fakeEnv(({ sql, method }) => {
    if (method === "first" && sql.includes("SELECT settings_json FROM settings")) {
      return { settings_json: JSON.stringify(settings()) };
    }
    throw new Error(`unexpected ${method} query: ${sql}`);
  });
}

function notificationTestRequest(channel: string, channelSettings: Record<string, unknown>): Request {
  return new Request("https://renewlet.test/api/app/notifications/test", {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      "content-type": "application/json",
      "x-renewlet-locale": "zh-CN",
    },
    body: JSON.stringify({
      channel,
      settings: channelSettings,
    }),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Cloudflare notification test endpoint upstream details", () => {
  beforeEach(() => {
    authMocks.requireAuth.mockReset();
    authMocks.requireAuth.mockResolvedValue({
      user: { id: "usr_due", role: "admin" },
      session: { id: "ses" },
    });
  });

  it("uses the current request locale instead of the account preference", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ code: 0, message: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const env = fakeEnv(({ sql, method }) => {
      if (method === "first" && sql.includes("SELECT settings_json FROM settings")) {
        return { settings_json: JSON.stringify(settings({
          localePreference: "en-US",
          serverchanSendKey: "SCT123456",
        })) };
      }
      throw new Error(`unexpected ${method} query: ${sql}`);
    });

    await expect(notificationTest(notificationTestRequest("serverchan", {}), env)).resolves.toMatchObject({ status: 200 });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      title: "Renewlet 测试通知",
      desp: expect.stringContaining("如果你收到了这条消息，说明该通知渠道配置可用。"),
    });
  });

  it("returns notification test failures with one-shot ServerChan upstream details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("too many requests for SCTsecret", {
      status: 429,
      statusText: "Too Many Requests",
      headers: { "content-type": "text/plain" },
    })));

    await expect(notificationTest(notificationTestRequest("serverchan", {
      enabledChannels: ["serverchan"],
      secretUpdates: {
        serverchanSendKey: { action: "set", value: "SCTsecret" },
      },
    }), settingsEnv())).rejects.toMatchObject({
      status: 400,
      code: "NOTIFICATION_TEST_FAILED",
      details: {
        rawResponseText: "too many requests for [redacted]",
      },
    });
  });

  it("returns Discord notification test timeouts before the browser request timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const caughtPromise = notificationTest(notificationTestRequest("discord", {
      enabledChannels: ["discord"],
      secretUpdates: {
        discordWebhookUrl: { action: "set", value: "https://discord.com/api/webhooks/123/discord-secret" },
      },
    }), settingsEnv()).catch((error: unknown) => error);
    await flushMicrotasks(20);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(NOTIFICATION_HTTP_TIMEOUT_MS);
    const caught = await caughtPromise;

    expect(caught).toMatchObject({
      status: 400,
      code: "NOTIFICATION_TEST_FAILED",
      details: {
        rawResponseText: expect.stringContaining("Discord POST request to https://discord.com/api/webhooks/123/[redacted]?wait=true timed out after 10s before response headers"),
      },
    });
    expect(JSON.stringify(caught)).not.toContain("discord-secret");
  });

  it("returns Discord notification test network failures with public target context", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
      throw new TypeError("Network connection lost.");
    });
    vi.stubGlobal("fetch", fetchMock);

    const caught = await notificationTest(notificationTestRequest("discord", {
      enabledChannels: ["discord"],
      secretUpdates: {
        discordWebhookUrl: { action: "set", value: "https://discord.com/api/webhooks/123/discord-secret?wait=true" },
      },
    }), settingsEnv()).catch((error: unknown) => error);

    expect(caught).toMatchObject({
      status: 400,
      code: "NOTIFICATION_TEST_FAILED",
      details: {
        rawResponseText: expect.stringContaining("Discord POST request to https://discord.com/api/webhooks/123/[redacted]?wait=true failed before response headers: Network connection lost."),
      },
    });
    expect(JSON.stringify(caught)).not.toContain("discord-secret");
    expect(JSON.stringify(caught)).toContain("/api/webhooks");
    expect(JSON.stringify(caught)).toContain("wait=true");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://discord.com/api/webhooks/123/discord-secret?wait=true");
  });
});
