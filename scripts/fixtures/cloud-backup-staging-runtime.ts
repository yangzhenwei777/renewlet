import { CronBudget } from "../../apps/worker/src/cron-budget";
import { runCloudBackupStep, readCloudBackupCursor } from "../../apps/worker/src/cloud-backup-cron";
import { buildCloudBackupExportZip } from "../../apps/worker/src/cloud-backup-export";
import { collectCloudBackupStaging, CLOUD_BACKUP_STAGING_GRACE_MS } from "../../apps/worker/src/cloud-backup-staging";
import type { CloudBackupPagedRemoteClient } from "../../apps/worker/src/cloud-backup-remote";
import type { Env } from "../../apps/worker/src/types";

const userId = "runtime-owner";
const now = new Date("2026-10-09T00:00:00.000Z");

// 仅由隔离测试Worker加载；真实D1/R2保存进度，远端上传保存到测试桶用于独立ZIP核对。
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/seed") {
      await env.DB.prepare("INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at) VALUES (?, 'fixture@example.test', 'Fixture', 'user', '', '', '')").bind(userId).run();
      const methods = Array.from({ length: 51 }, (_, index) => ({ id: `pm-${index}`, value: `pm-${index}`, labels: { "zh-CN": "Fixture", "en-US": "Fixture" }, icon: `/api/app/assets/asset-${index}` }));
      await env.DB.prepare("INSERT INTO custom_configs (user_id, config_json, created_at, updated_at) VALUES (?, ?, '', '')")
        .bind(userId, JSON.stringify({ categories: [], statuses: [], currencies: [], paymentMethods: methods })).run();
      await env.DB.prepare("INSERT INTO cloud_backup_targets (user_id, provider, created_at, updated_at) VALUES (?, 's3', '', '')").bind(userId).run();
      const statements: D1PreparedStatement[] = [];
      for (let index = 0; index < methods.length; index++) {
        // 八个接近2MiB的对象加小资产，覆盖跨页续接及近16MiB快照的实际R2传输。
        const bytes = new Uint8Array(index < 8 ? 2 * 1024 * 1024 - 32 * 1024 : 7).fill(index);
        await env.ASSETS_BUCKET.put(`private/${index}`, bytes);
        statements.push(env.DB.prepare("INSERT INTO assets (id, user_id, kind, r2_key, original_name, mime_type, size_bytes, created_at, updated_at) VALUES (?, ?, 'icon', ?, 'fixture.bin', 'application/octet-stream', ?, '', '')")
          .bind(`asset-${index}`, userId, `private/${index}`, bytes.length));
      }
      await env.DB.batch(statements);
      return new Response("ok");
    }
    if (path === "/expected") {
      const result = await buildCloudBackupExportZip(env, userId, now);
      return new Response(result.content as Uint8Array<ArrayBuffer>);
    }
    if (path === "/actual") {
      const object = await env.ASSETS_BUCKET.get("fixture-upload");
      return new Response(object?.body ?? null, { status: object ? 200 : 404 });
    }
    const budget = new CronBudget();
    const counted = { ...env, DB: budget.database(env.DB) };
    if (path === "/cleanup") {
      await collectCloudBackupStaging(counted, budget, new Date(Date.now() + CLOUD_BACKUP_STAGING_GRACE_MS));
      const records = await env.DB.prepare("SELECT count(*) AS n FROM cloud_backup_staging").first<number>("n");
      const objects = await env.ASSETS_BUCKET.list({ prefix: "system/cloud-backup-staging/" });
      return Response.json({ records, objects: objects.objects.length });
    }
    const client: CloudBackupPagedRemoteClient = {
      test: async () => { throw new Error("Unexpected connection test"); },
      list: async () => { throw new Error("Unexpected unpaged list"); },
      download: async () => { throw new Error("Unexpected remote download"); },
      prepareDirectory: async () => null,
      upload: async (_filename, content) => { await env.ASSETS_BUCKET.put("fixture-upload", content as Uint8Array<ArrayBuffer>); },
      writeSnapshot: async (_filename, content) => { await env.ASSETS_BUCKET.put("fixture-upload", content as Uint8Array<ArrayBuffer>); },
      verifySnapshot: async () => undefined,
      writeManifest: async () => undefined,
      listManifestPage: async () => ({ keys: [], cursor: null }),
      readManifest: async () => { throw new Error("Unexpected manifest read"); },
      deleteSnapshotFile: async () => { throw new Error("Unexpected deletion"); },
      listPage: async () => ({ manifests: [], cursor: null }),
      delete: async () => undefined,
    };
    const raw = await env.DB.prepare("SELECT cron_cursor_json FROM cloud_backup_targets WHERE user_id = ? AND provider = 's3'").bind(userId).first<string>("cron_cursor_json");
    const start = performance.now();
    const result = await runCloudBackupStep({ env: counted, userId, provider: "s3", client, cursor: readCloudBackupCursor(raw ?? "{}"), retention: 7, now, budget });
    await env.DB.prepare("UPDATE cloud_backup_targets SET cron_cursor_json = ? WHERE user_id = ? AND provider = 's3'").bind(result.kind === "complete" ? "{}" : JSON.stringify(result.cursor), userId).run();
    return Response.json({ result, resources: budget.used, wallMs: performance.now() - start });
  },
};
