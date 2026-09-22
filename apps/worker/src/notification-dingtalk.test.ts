import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import type { NotificationEmailMessage } from "@renewlet/shared/email-template";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationChannelError } from "./notification-errors";
import { renderWebhookPayloadTemplate } from "./notification-channel-send";
import { sendDingTalk, signedDingTalkWebhookUrl } from "./notification-dingtalk";

vi.mock("./smtp", () => ({
  notificationSmtpConfig: vi.fn(),
  sendSmtpEmail: vi.fn(),
}));

const baseMessage: NotificationEmailMessage = {
  title: "Renewlet",
  content: "即将到期：\n- GitHub：2026-08-01",
  timestamp: "2026-07-20 08:00 CST",
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Cloudflare DingTalk notification sender", () => {
  it("renders webhook JSON templates by replacing only string leaves", () => {
    const body = renderWebhookPayloadTemplate(
      `{"title":"{title}","content":"{content}","nested":["{timestamp}",{"copy":"{content}"}],"count":2}`,
      baseMessage,
      "zh-CN",
    );
    const parsed = JSON.parse(body) as { content: string; nested: [string, { copy: string }]; count: number };
    expect(parsed.content).toBe("即将到期：\n- GitHub：2026-08-01");
    expect(parsed.nested[0]).toBe("2026-07-20 08:00 CST");
    expect(parsed.nested[1].copy).toBe("即将到期：\n- GitHub：2026-08-01");
    expect(parsed.count).toBe(2);
  });

  it("rejects invalid webhook JSON templates", () => {
    expect(() => renderWebhookPayloadTemplate(`{"content":"{content}"`, baseMessage, "zh-CN")).toThrow("JSON");
  });

  it("overwrites DingTalk timestamp and sign query parameters", async () => {
    const endpoint = await signedDingTalkWebhookUrl(
      "https://93.184.216.34/robot/send?access_token=ding-token&timestamp=old&sign=old",
      "SECsecret",
      1_774_225_234_567,
    );

    expect(endpoint.searchParams.get("timestamp")).toBe("1774225234567");
    expect(endpoint.searchParams.get("sign")).toBeTruthy();
    expect(endpoint.toString()).not.toContain("old");
  });

  it("sends markdown payloads and treats errcode 0 as success", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(`{"errcode":0,"errmsg":"ok"}`, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendDingTalk(settings({
      dingtalkWebhookUrl: "https://93.184.216.34/robot/send?access_token=ding-token",
      dingtalkKeyword: "Renewlet",
    }), baseMessage, "zh-CN");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://93.184.216.34/robot/send?access_token=ding-token");
    expect(init?.method).toBe("POST");
    const payload = objectBody(init);
    expect(payload["msgtype"]).toBe("markdown");
    expect(payload["markdown"]).toMatchObject({
      title: "Renewlet",
      text: expect.stringContaining("GitHub"),
    });
    expect(payload["markdown"]).toMatchObject({
      text: "Renewlet\n\n即将到期：\n- GitHub：2026-08-01\n\n2026-07-20 08:00 CST",
    });
  });

  it("appends lowercase brand keyword as a footer marker instead of prepending it", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(`{"errcode":0,"errmsg":"ok"}`, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendDingTalk(settings({
      dingtalkWebhookUrl: "https://93.184.216.34/robot/send?access_token=ding-token",
      dingtalkKeyword: "renewlet",
    }), {
      ...baseMessage,
      title: "Renewlet 订阅提醒",
    }, "zh-CN");

    const payload = objectBody(fetchMock.mock.calls[0]?.[1]);
    expect(payload["markdown"]).toMatchObject({
      text: "Renewlet 订阅提醒\n\n即将到期：\n- GitHub：2026-08-01\n\n2026-07-20 08:00 CST\n\nrenewlet",
    });
  });

  it("applies DingTalk title and content templates while keeping unknown variables literal", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(`{"errcode":0,"errmsg":"ok"}`, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendDingTalk(settings({
      dingtalkWebhookUrl: "https://93.184.216.34/robot/send?access_token=ding-token",
      dingtalkKeyword: "安全词",
      dingtalkTitleTemplate: "{brand} · {title} · {unknown}",
      dingtalkContentTemplate: "{keyword}\n{title}\n{content}\n{timestamp}\n{itemCount}\n{unknown}",
    }), {
      ...baseMessage,
      title: "订阅提醒",
      content: "即将到期：\n- GitHub：{timestamp}",
      items: [
        { type: "renewal", name: "GitHub", price: "10", currency: "USD", status: "active", targetDate: "2026-08-01", reminderDays: 3 },
        { type: "trial", name: "Figma", price: "12", currency: "USD", status: "trial", targetDate: "2026-08-02", reminderDays: 3 },
      ],
    }, "zh-CN");

    const payload = objectBody(fetchMock.mock.calls[0]?.[1]);
    expect(payload["markdown"]).toMatchObject({
      title: "Renewlet · 订阅提醒 · {unknown}",
      text: expect.stringContaining("安全词\n订阅提醒"),
    });
    const text = (payload["markdown"] as { text: string }).text;
    expect(text.match(/安全词/g)).toHaveLength(1);
    expect(text.endsWith("\n\nRenewlet")).toBe(true);
    expect(JSON.stringify(payload["markdown"])).toContain("2");
    expect(JSON.stringify(payload["markdown"])).toContain("{unknown}");
    expect(JSON.stringify(payload["markdown"])).toContain("GitHub：{timestamp}");
  });

  it("signs text payloads and fails non-zero DingTalk business codes without leaking secrets", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      `{"errcode":310000,"errmsg":"keywords not in content SECsecret ding-token"}`,
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const caught = await sendDingTalk(settings({
      dingtalkWebhookUrl: "https://93.184.216.34/robot/send?access_token=ding-token&timestamp=old&sign=old",
      dingtalkSecret: "SECsecret",
      dingtalkKeyword: "自定义关键词",
      dingtalkMessageType: "text",
    }), { ...baseMessage, title: "提醒", content: "正文" }, "zh-CN").catch((error: unknown) => error);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const sentUrl = new URL(String(url));
    expect(sentUrl.searchParams.get("timestamp")).toBeTruthy();
    expect(sentUrl.searchParams.get("sign")).toBeTruthy();
    expect(sentUrl.toString()).not.toContain("old");
    const payload = objectBody(init);
    expect(payload["msgtype"]).toBe("text");
    expect(payload["text"]).toMatchObject({
      content: "提醒\n\n正文\n\n2026-07-20 08:00 CST\n\nRenewlet · 自定义关键词",
    });

    expect(caught).toBeInstanceOf(NotificationChannelError);
    if (caught instanceof NotificationChannelError) {
      expect(caught.message).toContain("310000");
      expect(caught.message).not.toContain("SECsecret");
      expect(caught.message).not.toContain("ding-token");
      expect(caught.details?.rawResponseText).toContain("[redacted]");
      expect(caught.details?.rawResponseText).not.toContain("SECsecret");
      expect(caught.details?.rawResponseText).not.toContain("ding-token");
    }
  });

  it.each([410100, 40035, 400105])("fails DingTalk business errcode %s", async (errcode) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ errcode, errmsg: "failed" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendDingTalk(settings({
      dingtalkWebhookUrl: "https://93.184.216.34/robot/send?access_token=ding-token",
    }), baseMessage, "zh-CN")).rejects.toThrow(`errcode=${errcode}`);
  });
});
