import { HttpRequest } from "@smithy/core/protocols";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import { CronS3HttpHandler } from "../src/cloud-backup-s3-http";
import { CronBudget } from "../src/cron-budget";
import { runCloudBackupStep, readCloudBackupCursor } from "../src/cloud-backup-cron";
import { S3CloudBackupClient } from "../src/cloud-backup-remote";
import type { Env } from "../src/types";

const settings = { ...createDefaultAppSettings(), timezone: "UTC" };
const now = new Date("2026-10-09T08:00:00.000Z");
const userId = "transport-fixture";

// 仅由隔离workerd测试入口加载；实际HTTP发往回环服务器，不替换fetch、不使用真实凭据。
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const endpoint = new URL(url.searchParams.get("endpoint") ?? "http://127.0.0.1");
    if (endpoint.hostname !== "127.0.0.1") throw new Error("Loopback fixture only");
    const budget = new CronBudget();
    if (url.pathname === "/seed") {
      await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
      await env.DB.prepare("INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at) VALUES (?, 'fixture@example.test', 'Fixture', 'user', '', '', '')").bind(userId).run();
      await env.DB.prepare("INSERT INTO settings (user_id, settings_json, created_at, updated_at) VALUES (?, ?, '', '')").bind(userId, JSON.stringify(settings)).run();
      await env.DB.prepare("INSERT INTO cloud_backup_targets (user_id, provider, created_at, updated_at) VALUES (?, 's3', '', '')").bind(userId).run();
      return new Response("ok");
    }
    if (url.pathname === "/tick") {
      const started = performance.now();
      const counted = { ...env, DB: budget.database(env.DB) };
      const raw = await counted.DB.prepare("SELECT cron_cursor_json FROM cloud_backup_targets WHERE user_id = ? AND provider = 's3'").bind(userId).first<string>("cron_cursor_json");
      // 直接注入回环provider，不通过生产配置入口；该入口仍严格拒绝HTTP endpoint。
      const client = new S3CloudBackupClient({ endpoint: endpoint.href, bucket: "backup-test", prefix: "", region: "us-east-1", accessKeyId: "fixture-access", addressingStyle: "pathStyle" }, "fixture-secret", budget);
      const result = await runCloudBackupStep({ env: counted, userId, provider: "s3", client, cursor: readCloudBackupCursor(raw ?? "{}"), retention: 2, now, budget });
      await counted.DB.prepare("UPDATE cloud_backup_targets SET cron_cursor_json = ?, last_status = ? WHERE user_id = ? AND provider = 's3'")
        .bind(result.kind === "complete" ? "{}" : JSON.stringify(result.cursor), result.kind === "complete" ? "success" : "idle", userId).run();
      const row = await env.DB.prepare("SELECT cron_cursor_json, last_status, last_error FROM cloud_backup_targets WHERE user_id = ? AND provider = 's3'").bind(userId).first();
      return Response.json({ row, resources: budget.used, wallMs: performance.now() - started });
    }
    const method = url.searchParams.get("method") ?? "GET";
    const initial = new HttpRequest({
      protocol: endpoint.protocol, hostname: endpoint.hostname, port: Number(endpoint.port), path: endpoint.pathname,
      query: { special: "a+b /?=", repeated: ["z", "a"] }, method,
      headers: { host: endpoint.host, authorization: "fixture-authorization", cookie: "fixture-cookie", "x-fixture": "kept",
        ...(method === "POST" || method === "PUT" ? { "content-type": "application/octet-stream", "content-language": "en", "content-location": "/fixture", "content-length": "12" } : {}) },
      ...(method === "POST" || method === "PUT" ? { body: new TextEncoder().encode("fixture-body") } : {}),
    });
    budget.consumeExternal(Number(url.searchParams.get("reserved") ?? 0));
    const counted = url.searchParams.get("handler") !== "native";
    const handler = counted ? new CronS3HttpHandler(budget, 5_000) : new FetchHttpHandler({ cache: "no-store", requestTimeout: 5_000 });
    try {
      const result = await handler.handle(initial);
      const body = result.response.body as ReadableStream | Blob;
      return Response.json({ status: result.response.statusCode, body: await new Response(body).text(), resources: budget.used });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.name : "unknown", resources: budget.used });
    }
  },
};
