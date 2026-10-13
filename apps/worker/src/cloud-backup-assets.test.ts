import { afterEach, describe, expect, it, vi } from "vitest";
import { createCronFixture, scheduledAt, settings } from "./cron-test-support";
import { createCloudBackupBucket } from "./cloud-backup-staging-test-support";
import { insertSubscriptionStatement, subscriptionRow } from "./subscription-d1-test-support";
import { buildCloudBackupExportZip } from "./cloud-backup-export";
import { runScheduledCloudBackupForUser } from "./cloud-backup";
import { readCloudBackupCursor } from "./cloud-backup-cron";
import { S3CloudBackupClient } from "./cloud-backup-remote";
import { CronBudget } from "./cron-budget";
import { collectCloudBackupStaging, CLOUD_BACKUP_STAGING_GRACE_MS, readCloudBackupStaging } from "./cloud-backup-staging";
import { readStoredZipText } from "./zip-store-test-support";
import { prepareCloudBackupAssets } from "./cloud-backup-assets";
import { Buffer } from "node:buffer";

vi.mock("./smtp", () => ({ notificationSmtpConfig: vi.fn(), sendSmtpEmail: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function expectExactBytes(actual: Uint8Array | undefined, expected: Uint8Array) {
  if (!actual) throw new Error("Missing uploaded ZIP bytes");
  expect(actual.byteLength).toBe(expected.byteLength);
  if (actual.byteLength !== expected.byteLength) return;
  // 大型快照仍需逐字节相等；Node 原生比较避免 Vitest 递归枚举百万个 Uint8Array 元素而耗尽 CI 单测时限。
  expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected))).toBe(0);
}

async function fixture(assetCount: number, subscriptions = assetCount) {
  vi.useFakeTimers();
  vi.setSystemTime(scheduledAt);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const base = createCronFixture(2);
  const storage = createCloudBackupBucket();
  base.env.ASSETS_BUCKET = storage.bucket;
  const userId = "usr-0000";
  const insert = base.db.prepare("INSERT INTO assets (id, user_id, kind, r2_key, original_name, mime_type, size_bytes, created_at, updated_at) VALUES (?, ?, 'logo', ?, 'logo.svg', 'image/svg+xml', 7, '', '')");
  for (let index = 0; index < assetCount; index++) {
    insert.run(`asset-${index}`, userId, `private/asset-${index}`);
    storage.objects.set(`private/asset-${index}`, { bytes: new TextEncoder().encode("<svg />"), metadata: {} });
  }
  for (let index = 0; index < subscriptions; index++) {
    await insertSubscriptionStatement(base.env, subscriptionRow(`sub-${index}`, { user_id: userId, logo: `/api/app/assets/asset-${index % assetCount}` })).run();
  }
  base.db.prepare(`INSERT INTO cloud_backup_targets (user_id, provider, config_json, credential_json, schedule_enabled, created_at, updated_at)
    VALUES (?, 's3', ?, ?, 1, ?, ?)`).run(userId,
    JSON.stringify({ s3: { endpoint: "https://s3.example.test", bucket: "backups", region: "auto", prefix: "", accessKeyId: "fixture", addressingStyle: "pathStyle" } }),
    JSON.stringify({ s3SecretAccessKey: "secret-fixture" }), scheduledAt.toISOString(), scheduledAt.toISOString());
  vi.spyOn(S3CloudBackupClient.prototype, "prepareDirectory").mockResolvedValue(null);
  vi.spyOn(S3CloudBackupClient.prototype, "listManifestPage").mockResolvedValue({ keys: [], cursor: null });
  vi.spyOn(S3CloudBackupClient.prototype, "verifySnapshot").mockResolvedValue(undefined);
  vi.spyOn(S3CloudBackupClient.prototype, "writeManifest").mockResolvedValue(undefined);
  const upload = vi.spyOn(S3CloudBackupClient.prototype, "writeSnapshot").mockResolvedValue(undefined);
  const row = () => base.db.prepare("SELECT cron_cursor_json, last_status, last_error FROM cloud_backup_targets WHERE user_id = ? AND provider = 's3'").get(userId);
  const budgets: CronBudget[] = [];
  const run = async () => {
    const budget = new CronBudget();
    budgets.push(budget);
    return runScheduledCloudBackupForUser({ ...base.env, DB: budget.database(base.env.DB, 3) }, userId, "s3", scheduledAt, new Date(), settings, budget, budget.database(base.env.DB));
  };
  const gc = () => {
    const budget = new CronBudget();
    return collectCloudBackupStaging({ ...base.env, DB: budget.database(base.env.DB) }, budget, new Date());
  };
  return { ...base, storage, userId, row, run, budgets, upload, gc };
}

describe("durable backup asset preparation", () => {
  it.each([475, 476, 1000])("resumes %i assets for 1000 subscriptions and uploads the identical v1 ZIP", async (count) => {
    const state = await fixture(count, 1000);
    try {
      const expected = await buildCloudBackupExportZip(state.env, state.userId, scheduledAt);
      state.storage.head.mockClear(); state.storage.get.mockClear();
      for (let tick = 0; tick < 30 && state.row()?.["last_status"] !== "success"; tick++) await state.run();
      expect(state.row()).toMatchObject({ cron_cursor_json: "{}", last_status: "success" });
      expect(state.upload).toHaveBeenCalledTimes(1);
      expectExactBytes(state.upload.mock.calls[0]?.[1], expected.content);
      expect(state.storage.head).toHaveBeenCalledTimes(count);
      expect(state.storage.get.mock.calls.filter(([key]) => key.startsWith("private/"))).toHaveLength(count);
      expect(Math.max(...state.budgets.map((budget) => budget.used.storageReserved))).toBeLessThanOrEqual(102);
      expect(Math.max(...state.budgets.map((budget) => budget.used.sql))).toBeLessThanOrEqual(50);
      expect(readStoredZipText(expected.content, "manifest.json")).toContain('"missingAssets": []');
      process.stdout.write(`${JSON.stringify({ environment: "Node + SQLite + simulated R2", assets: count, subscriptions: 1000, ticks: state.budgets.length, zipBytes: expected.content.length,
        maxSql: Math.max(...state.budgets.map((budget) => budget.used.sql)), maxStorageReserved: Math.max(...state.budgets.map((budget) => budget.used.storageReserved)), zipIdentical: true })}\n`);
      vi.advanceTimersByTime(CLOUD_BACKUP_STAGING_GRACE_MS);
      for (let page = 0; page < 10; page++) await state.gc();
      expect(state.db.prepare("SELECT * FROM cloud_backup_staging").all()).toEqual([]);
      expect([...state.storage.objects.keys()].every((key) => key.startsWith("private/"))).toBe(true);
    } finally { state.db.close(); }
  });

  it("checkpoints a partial page when earlier work has spent most of the R2 budget", async () => {
    const state = await fixture(51);
    try {
      const budget = new CronBudget();
      budget.consumeStorage(940);
      const prepared = await prepareCloudBackupAssets({ env: { ...state.env, DB: budget.database(state.env.DB) },
        owner: { userId: state.userId, provider: "s3", id: "bounded" }, exportedAt: scheduledAt, stagingKey: null, budget });
      expect(prepared.complete).toBe(false);
      expect(state.storage.head).toHaveBeenCalledTimes(4);
      expect(budget.used.storageReserved).toBe(950);
      const next = await prepareCloudBackupAssets({ env: state.env, owner: { userId: state.userId, provider: "s3", id: "bounded" }, exportedAt: scheduledAt, stagingKey: prepared.stagingKey, budget: new CronBudget() });
      expect(next.complete).toBe(true);
      expect(state.storage.head).toHaveBeenCalledTimes(51);
    } finally { state.db.close(); }
  });

  it("keeps foreign and missing references out of staged ZIPs and strips credentials", async () => {
    const state = await fixture(1);
    try {
      state.db.prepare("INSERT INTO assets (id, user_id, kind, r2_key, size_bytes, created_at, updated_at) VALUES ('foreign', 'usr-0001', 'icon', 'secret/foreign', 7, '', '')").run();
      const paymentMethods = ["asset-0", "foreign", "missing"].map((id) => ({ id, value: id, labels: { "zh-CN": id, "en-US": id }, icon: `/api/app/assets/${id}` }));
      state.db.prepare("INSERT INTO custom_configs (user_id, config_json, created_at, updated_at) VALUES (?, ?, '', '')")
        .run(state.userId, JSON.stringify({ categories: [], statuses: [], currencies: [], paymentMethods }));
      const expected = await buildCloudBackupExportZip(state.env, state.userId, scheduledAt);
      for (let tick = 0; tick < 8; tick++) await state.run();
      expect(state.row()?.["last_status"]).toBe("success");
      const bytes = state.upload.mock.calls[0]?.[1];
      expectExactBytes(bytes, expected.content);
      const manifest = JSON.parse(readStoredZipText(expected.content, "manifest.json"));
      expect(manifest.missingAssets.map((asset: { assetId: string; reason: string }) => [asset.assetId, asset.reason])).toEqual([["foreign", "not_found"], ["missing", "not_found"]]);
      expect(state.storage.head.mock.calls.flat()).not.toContain("secret/foreign");
      const text = new TextDecoder().decode(bytes);
      expect(text).not.toContain("secret-fixture");
      expect(text).not.toContain("r2Key");
      expect(text).not.toContain("system/cloud-backup-staging");
    } finally { state.db.close(); }
  });

  it("freezes business data and completed asset bytes across restarts and failed upload responses", async () => {
    const state = await fixture(51);
    try {
      const expected = await buildCloudBackupExportZip(state.env, state.userId, scheduledAt);
      await state.run(); await state.run(); await state.run();
      const saved = state.row()?.["cron_cursor_json"];
      expect(readCloudBackupCursor(String(saved))?.stage).toBe("prepare");
      state.db.prepare("UPDATE subscriptions SET name = 'Changed after snapshot'").run();
      const readKey = state.storage.head.mock.calls.at(-1)?.[0];
      if (!readKey) throw new Error("Missing asset read");
      state.storage.objects.delete(readKey);
      await state.run();
      const ready = state.row()?.["cron_cursor_json"];
      state.upload.mockRejectedValueOnce(new Error("lost upload response"));
      await state.run();
      expect(state.row()?.["cron_cursor_json"]).toBe(ready);
      await state.run();
      expect(state.upload).toHaveBeenCalledTimes(2);
      expectExactBytes(state.upload.mock.calls[0]?.[1], expected.content);
      expectExactBytes(state.upload.mock.calls[1]?.[1], expected.content);
    } finally { state.db.close(); }
  });

  it("keeps the previous checkpoint after a failed put and reclaims abandoned writes after account deletion", async () => {
    const state = await fixture(51);
    try {
      await state.run(); await state.run(); await state.run();
      const before = state.row()?.["cron_cursor_json"];
      state.storage.put.mockRejectedValueOnce(new Error("storage unavailable"));
      await state.run();
      expect(state.row()?.["cron_cursor_json"]).toBe(before);
      expect(state.db.prepare("SELECT count(*) AS count FROM cloud_backup_staging").get()?.["count"]).toBe(2);
      await state.run();
      await state.gc();
      expect(state.storage.remove).not.toHaveBeenCalled();
      state.db.prepare("DELETE FROM users WHERE id = ?").run(state.userId);
      vi.advanceTimersByTime(CLOUD_BACKUP_STAGING_GRACE_MS);
      state.storage.remove.mockRejectedValueOnce(new Error("delete unavailable"));
      await expect(state.gc()).rejects.toThrow("delete unavailable");
      expect(state.db.prepare("SELECT count(*) AS count FROM cloud_backup_staging").get()?.["count"]).toBe(3);
      await state.gc();
      expect(state.db.prepare("SELECT * FROM cloud_backup_staging").all()).toEqual([]);
    } finally { state.db.close(); }
  });

  it("fences a configuration reset during put and refuses a different owner's staged object", async () => {
    const state = await fixture(51);
    try {
      await state.run(); await state.run();
      const put = state.storage.put.getMockImplementation();
      if (!put) throw new Error("Missing put implementation");
      state.storage.put.mockImplementationOnce(async (...args) => {
        const result = await put(...args);
        state.db.prepare("UPDATE cloud_backup_targets SET cron_cursor_json = '{}', cron_claim_token = NULL, locked_until = NULL").run();
        return result;
      });
      expect(await state.run()).toBe(false);
      expect(state.row()?.["cron_cursor_json"]).toBe("{}");
      const abandoned = [...state.storage.objects.keys()].find((key) => key.startsWith("system/"));
      if (!abandoned) throw new Error("Missing staged object");
      const metadata = state.storage.objects.get(abandoned)?.metadata;
      await expect(readCloudBackupStaging(state.env, { userId: "usr-0001", provider: "s3", id: metadata?.["snapshotId"] ?? "" }, abandoned, "assets", 32 * 1024 * 1024)).rejects.toThrow("CLOUD_BACKUP_STAGING_INVALID");
      await state.run(); await state.run(); await state.run();
      const active = readCloudBackupCursor(String(state.row()?.["cron_cursor_json"]));
      if (active?.stage !== "prepare") throw new Error("Missing active preparation");
      vi.advanceTimersByTime(CLOUD_BACKUP_STAGING_GRACE_MS);
      await state.gc();
      expect(state.storage.objects.has(abandoned)).toBe(false);
      expect(state.storage.objects.has(active.stagingKey ?? "")).toBe(true);
      expect(state.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { state.db.close(); }
  });
});
