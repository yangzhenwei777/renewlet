import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import { CronBudget } from "../src/cron-budget";
import { notificationSenders } from "../src/notification-channel-send";
import { runCronForUser } from "../src/notification-cron";
import { getNotificationJob } from "../src/notification-jobs";
import { readNotificationHistoryRows } from "../src/notification-message-storage";
import { sendNotificationRequest, requireNotificationHttpOk } from "../src/notification-http";
import { sendUpstreamRequest } from "../src/upstream-http";
import { scheduleOccurrence } from "../src/notification-schedule";
import type { Env } from "../src/types";

const channels = ["telegram", "notifyx", "serverchan"] as const;
const settings = { ...createDefaultAppSettings(), timezone: "UTC", enabledChannels: [...channels] };
const schedule = scheduleOccurrence("2026-10-09", "08:00", "UTC");
const userId = "notification-fixture";

// 隔离测试入口才允许回环provider；生产配置仍使用原有HTTPS/DoH校验，fixture不进入部署产物。
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const endpoint = new URL(url.searchParams.get("endpoint") ?? "http://127.0.0.1");
    if (endpoint.hostname !== "127.0.0.1") throw new Error("Loopback fixture only");
    const budget = new CronBudget();
    if (url.pathname === "/seed") {
      await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
      await env.DB.prepare("INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at) VALUES (?, 'notification@example.test', 'Fixture', 'user', '', '', '')").bind(userId).run();
      return new Response("ok");
    }
    if (url.pathname === "/tick") {
      for (const channel of channels) notificationSenders[channel] = async (context) => {
        const response = await sendNotificationRequest(endpoint, { method: "POST", body: JSON.stringify(context.message) }, channel, context.locale, { ...(context.budget ? { budget: context.budget } : {}) });
        await requireNotificationHttpOk(response, channel, context.locale);
      };
      const result = await runCronForUser({ ...env, DB: budget.database(env.DB, 3) }, userId, settings, schedule, new Date(), "en-US", () => ({ title: "Reminder", content: url.searchParams.get("content") ?? "frozen notification", timestamp: "08:00", hasPayload: true, items: [] }), budget);
      const row = await getNotificationJob(env, userId, schedule);
      const [history] = await readNotificationHistoryRows(env, userId, "all", 1);
      return Response.json({ result, row, history, resources: budget.used });
    }
    const method = url.searchParams.get("method") ?? "GET";
    const init: RequestInit = { method,
      headers: { authorization: "fixture-authorization", cookie: "fixture-cookie", "x-fixture": "kept",
        ...(method === "POST" || method === "PUT" ? { "content-type": "application/octet-stream", "content-language": "en", "content-location": "/fixture", "content-length": "12" } : {}) },
      ...(method === "POST" || method === "PUT" ? { body: "fixture-body" } : {}),
    };
    if (url.searchParams.has("implicit")) {
      const headers = new Headers(init.headers);
      headers.delete("content-type");
      init.headers = headers;
    }
    budget.consumeExternal(Number(url.searchParams.get("reserved") ?? 0));
    const counted = url.searchParams.get("handler") !== "native";
    try {
      let status = 0;
      for (let index = 0; index < Number(url.searchParams.get("sends") ?? 1); index++) {
        const response = await sendUpstreamRequest(endpoint, init, { provider: "fixture", timeoutMs: 5_000, ...(counted ? { budget } : {}) });
        status = response.status;
        await response.text();
      }
      return Response.json({ status, resources: budget.used });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.name : "unknown", resources: budget.used }); }
  },
};
