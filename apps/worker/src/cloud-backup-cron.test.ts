import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudBackupSnapshotManifest } from "@renewlet/shared/schemas/cloud-backup";
import { createCronFixture, scheduledAt, settings } from "./cron-test-support";
import { CronBudget, CronBudgetExceeded } from "./cron-budget";
import { readCloudBackupCursor } from "./cloud-backup-cron";
import { runScheduledCloudBackupForUser } from "./cloud-backup";
import { CloudBackupRemoteError, S3CloudBackupClient, WebDAVCloudBackupClient } from "./cloud-backup-remote";
import { createCloudBackupBucket } from "./cloud-backup-staging-test-support";

vi.mock("./smtp", () => ({ notificationSmtpConfig: vi.fn(), sendSmtpEmail: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(scheduledAt);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const base = createCronFixture(1);
  base.env.ASSETS_BUCKET = createCloudBackupBucket().bucket;
  const userId = base.ids[0] ?? "";
  for (const provider of ["webdav", "s3"] as const) {
    const config = provider === "webdav" ? { webdav: { url: "https://dav.example.test/", username: "fixture", path: "backups" } }
      : { s3: { endpoint: "https://s3.example.test", bucket: "backups", region: "auto", prefix: "", accessKeyId: "fixture", addressingStyle: "pathStyle" } };
    base.db.prepare(`INSERT INTO cloud_backup_targets (user_id, provider, config_json, credential_json, schedule_enabled, retention, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 2, ?, ?)`).run(userId, provider, JSON.stringify(config), JSON.stringify({ webdavPassword: "fixture", s3SecretAccessKey: "fixture" }), scheduledAt.toISOString(), scheduledAt.toISOString());
  }
  let ticks = 0;
  const budgets: CronBudget[] = [];
  const run = async (provider: "webdav" | "s3" = "webdav") => {
    const now = new Date(scheduledAt.getTime() + ticks++ * 60_000);
    vi.setSystemTime(now);
    const budget = new CronBudget();
    budgets.push(budget);
    return runScheduledCloudBackupForUser({ ...base.env, DB: budget.database(base.env.DB, 3) }, userId, provider, now, now, settings, budget, budget.database(base.env.DB));
  };
  const row = (provider = "webdav") => base.db.prepare("SELECT cron_cursor_json, last_backup_at, last_status, last_error, locked_until FROM cloud_backup_targets WHERE user_id = ? AND provider = ?").get(userId, provider);
  return { ...base, userId, run, row, budgets };
}

function manifest(id: string, createdAt: string): CloudBackupSnapshotManifest {
  return { kind: "renewlet-cloud-backup-snapshot", schemaVersion: 1, id, filename: `${id}.zip`, createdAt, sizeBytes: 100, sha256: "a".repeat(64), exportKind: "renewlet-export", exportSchemaVersion: 1 };
}

function remote() {
  const objects = new Map<string, CloudBackupSnapshotManifest>(Array.from({ length: 9 }, (_, index) => {
    const item = manifest(`old-${index}`, `2026-09-0${index + 1}T01:00:00.000Z`);
    return [item.id, item];
  }));
  const directory = vi.spyOn(WebDAVCloudBackupClient.prototype, "prepareDirectory").mockImplementation(async (after) => after === null ? "backups" : null);
  const upload = vi.spyOn(WebDAVCloudBackupClient.prototype, "writeSnapshot").mockResolvedValue(undefined);
  const verify = vi.spyOn(WebDAVCloudBackupClient.prototype, "verifySnapshot").mockResolvedValue(undefined);
  const commit = vi.spyOn(WebDAVCloudBackupClient.prototype, "writeManifest").mockImplementation(async (value) => { objects.set(value.id, value); });
  const list = vi.spyOn(WebDAVCloudBackupClient.prototype, "listManifestPage").mockImplementation(async (after, limit) => {
    const items = [...objects.values()].filter((item) => after === null || item.id > after).sort((left, right) => left.id.localeCompare(right.id));
    const page = items.slice(0, limit);
    return { keys: page.map((item) => item.id), cursor: items.length > limit ? page.at(-1)?.id ?? null : null };
  });
  const read = vi.spyOn(WebDAVCloudBackupClient.prototype, "readManifest").mockImplementation(async (id) => {
    const item = objects.get(id);
    if (!item) throw new Error("Missing fixture manifest");
    return item;
  });
  const remove = vi.spyOn(WebDAVCloudBackupClient.prototype, "deleteSnapshotFile").mockImplementation(async (id, part) => { if (part === "manifest") objects.delete(id); });
  return { objects, directory, upload, verify, commit, list, read, remove };
}

describe("durable cloud backup stages", () => {
  it.each(["scan", "prune"] as const)("continues an existing %s cursor without uploading again", async (stage) => {
    const state = fixture();
    const client = remote();
    const createdAt = scheduledAt.toISOString();
    client.objects.set("uploaded", manifest("uploaded", createdAt));
    const oldCursor = { id: "uploaded", createdAt, stage, after: "old-3", retained: [{ id: "uploaded", createdAt }, { id: "old-8", createdAt: "2026-09-09T01:00:00.000Z" }] };
    state.db.prepare("UPDATE cloud_backup_targets SET cron_cursor_json = ? WHERE provider = 'webdav'").run(JSON.stringify(oldCursor));
    try {
      for (let tick = 0; tick < 80 && state.row()?.["last_status"] !== "success"; tick++) await state.run();
      expect(state.row()).toMatchObject({ last_status: "success", cron_cursor_json: "{}" });
      expect(client.upload).not.toHaveBeenCalled();
      expect(client.list.mock.calls[0]?.[0]).toBe("old-3");
      expect(client.objects.has("uploaded")).toBe(true);
      expect(client.objects.has("old-8")).toBe(true);
      for (const id of ["old-4", "old-5", "old-6", "old-7"]) expect(client.objects.has(id)).toBe(false);
    } finally { state.db.close(); }
  });

  it("resumes directory, upload and both retention passes while preserving intervening snapshots", async () => {
    const state = fixture();
    const client = remote();
    try {
      let injected = false;
      for (let tick = 0; tick < 100 && state.row()?.["last_status"] !== "success"; tick++) {
        const before = Object.values(client).filter((value) => vi.isMockFunction(value)).reduce((sum, mock) => sum + mock.mock.calls.length, 0);
        await state.run();
        const after = Object.values(client).filter((value) => vi.isMockFunction(value)).reduce((sum, mock) => sum + mock.mock.calls.length, 0);
        expect(after - before).toBeLessThanOrEqual(1);
        const cursor = readCloudBackupCursor(String(state.row()?.["cron_cursor_json"]));
        if (cursor?.stage === "prune" && !injected) {
          expect(client.remove).not.toHaveBeenCalled();
          client.objects.set("newer", manifest("newer", "2026-09-10T08:00:00.000Z"));
          injected = true;
        }
      }
      expect(state.row()).toMatchObject({ cron_cursor_json: "{}", last_status: "success", locked_until: null });
      expect(client.directory).toHaveBeenCalledTimes(2);
      expect(client.upload).toHaveBeenCalledTimes(1);
      expect(client.list.mock.calls.every(([, limit]) => limit === 4)).toBe(true);
      expect(client.objects.has("newer")).toBe(true);
      expect(client.objects.has("old-8")).toBe(true);
      expect(client.objects.has(client.commit.mock.calls[0]?.[0].id ?? "")).toBe(true);
      expect(client.remove).toHaveBeenCalled();
      expect(Math.max(...state.budgets.map((budget) => budget.used.sql))).toBeLessThanOrEqual(50);
      expect(Math.max(...state.budgets.map((budget) => budget.used.externalReserved))).toBeLessThanOrEqual(50);
    } finally { state.db.close(); }
  });

  it.each(["verify", "commit"] as const)("persists %s failure cleanup, keeps the primary error and retries the frozen ZIP", async (phase) => {
    const state = fixture();
    const client = remote();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const code = phase === "verify" ? "CLOUD_BACKUP_WEBDAV_STAT_MISMATCH" : "CLOUD_BACKUP_WEBDAV_PUT_FAILED";
    client[phase].mockRejectedValueOnce(new CloudBackupRemoteError(code));
    try {
      for (let tick = 0; tick < 10 && readCloudBackupCursor(String(state.row()?.["cron_cursor_json"]))?.stage !== "cleanup-upload"; tick++) await state.run();
      const cleanup = state.row()?.["cron_cursor_json"];
      expect(readCloudBackupCursor(String(cleanup))?.stage).toBe("cleanup-upload");
      expect(state.row()).toMatchObject({ last_status: "failed", last_error: code });
      // 预算中断不能吃掉清理步骤；真正的清理故障只记录稳定码，并继续使用同一份冻结快照。
      client.remove.mockRejectedValueOnce(new CronBudgetExceeded("external"));
      await state.run();
      expect(state.row()?.["cron_cursor_json"]).toBe(cleanup);
      client.remove.mockRejectedValueOnce(new Error("sensitive upstream response"));
      await state.run();
      expect(state.row()?.["last_error"]).toBe(code);
      expect(warn).toHaveBeenCalledExactlyOnceWith("cloud_backup_cleanup_failed", {
        event: "cloud_backup_cleanup_failed", provider: "webdav", part: "zip", code: "local_sdk_error",
      });
      if (phase === "commit") {
        expect(readCloudBackupCursor(String(state.row()?.["cron_cursor_json"]))).toMatchObject({ stage: "cleanup-upload", remaining: ["manifest"] });
        await state.run();
        expect(client.remove.mock.calls.at(-1)?.[1]).toBe("manifest");
      }
      expect(readCloudBackupCursor(String(state.row()?.["cron_cursor_json"]))?.stage).toBe("upload");
      await state.run();
      expect(client.upload.mock.calls[1]).toEqual(client.upload.mock.calls[0]);
      for (let tick = 0; tick < 100 && state.row()?.["last_status"] !== "success"; tick++) await state.run();
      expect(state.row()).toMatchObject({ last_status: "success", last_error: null, cron_cursor_json: "{}" });
    } finally { state.db.close(); }
  });

  it("resumes a deletion after the ZIP is gone without relisting or repeating successful operations", async () => {
    const state = fixture();
    const client = remote();
    try {
      for (let tick = 0; tick < 60 && readCloudBackupCursor(String(state.row()?.["cron_cursor_json"]))?.stage !== "remove"; tick++) await state.run();
      const before = readCloudBackupCursor(String(state.row()?.["cron_cursor_json"]));
      expect(before).toMatchObject({ stage: "remove", part: "zip" });
      await state.run();
      const checkpoint = state.row()?.["cron_cursor_json"];
      const lists = client.list.mock.calls.length;
      expect(readCloudBackupCursor(String(checkpoint))).toMatchObject({ stage: "remove", part: "manifest" });
      client.remove.mockRejectedValueOnce(new CloudBackupRemoteError("CLOUD_BACKUP_WEBDAV_DELETE_FAILED"));
      await state.run();
      expect(state.row()?.["cron_cursor_json"]).toBe(checkpoint);
      await state.run();
      expect(client.list).toHaveBeenCalledTimes(lists);
      expect(client.remove.mock.calls.map(([, part]) => part)).toEqual(["zip", "manifest", "manifest"]);
    } finally { state.db.close(); }
  });

  it("cannot commit a successful remote operation after another executor takes the claim", async () => {
    const state = fixture();
    const client = remote();
    try {
      for (let tick = 0; tick < 10 && readCloudBackupCursor(String(state.row()?.["cron_cursor_json"]))?.stage !== "verify-upload"; tick++) await state.run();
      const checkpoint = state.row()?.["cron_cursor_json"];
      client.verify.mockImplementationOnce(async () => {
        state.db.prepare("UPDATE cloud_backup_targets SET cron_claim_token = 'replacement' WHERE provider = 'webdav'").run();
      });
      expect(await state.run()).toBe(false);
      expect(state.row()?.["cron_cursor_json"]).toBe(checkpoint);
      expect(client.commit).not.toHaveBeenCalled();
    } finally { state.db.close(); }
  });

  it("reuses the persisted ID after an interrupted upload and validates every manifest before deleting", async () => {
    const state = fixture();
    const client = remote();
    try {
      await state.run(); await state.run(); await state.run(); await state.run();
      const before = state.row()?.["cron_cursor_json"];
      client.upload.mockRejectedValueOnce(new Error("lost response Bearer secret"));
      await state.run();
      expect(state.row()).toMatchObject({ cron_cursor_json: before, last_status: "failed", last_error: "local_sdk_error" });
      await state.run();
      expect(client.upload.mock.calls[0]?.[0]).toBe(client.upload.mock.calls[1]?.[0]);
      expect(client.upload.mock.calls[0]?.[1]).toEqual(client.upload.mock.calls[1]?.[1]);
      for (let tick = 0; tick < 10 && readCloudBackupCursor(String(state.row()?.["cron_cursor_json"]))?.stage !== "inspect"; tick++) await state.run();
      client.read.mockRejectedValueOnce(new CloudBackupRemoteError("CLOUD_BACKUP_MANIFEST_INVALID"));
      const cursor = state.row()?.["cron_cursor_json"];
      await state.run();
      expect(state.row()).toMatchObject({ cron_cursor_json: cursor, last_status: "failed", last_error: "CLOUD_BACKUP_MANIFEST_INVALID" });
      expect(client.remove).not.toHaveBeenCalled();
      for (let tick = 0; tick < 100 && state.row()?.["last_status"] !== "success"; tick++) await state.run();
      expect(state.row()?.["last_status"]).toBe("success");
      expect(client.upload).toHaveBeenCalledTimes(2);
    } finally { state.db.close(); }
  });

  it("allows S3 to finish while WebDAV fails and fences a configuration change during a remote operation", async () => {
    const state = fixture();
    const client = remote();
    vi.spyOn(S3CloudBackupClient.prototype, "prepareDirectory").mockResolvedValue(null);
    const s3Upload = vi.spyOn(S3CloudBackupClient.prototype, "writeSnapshot").mockResolvedValue(undefined);
    vi.spyOn(S3CloudBackupClient.prototype, "listManifestPage").mockResolvedValue({ keys: [], cursor: null });
    vi.spyOn(S3CloudBackupClient.prototype, "verifySnapshot").mockResolvedValue(undefined);
    vi.spyOn(S3CloudBackupClient.prototype, "writeManifest").mockResolvedValue(undefined);
    try {
      await state.run();
      client.directory.mockRejectedValue(new CloudBackupRemoteError("CLOUD_BACKUP_WEBDAV_MKCOL_FAILED"));
      await state.run();
      for (let tick = 0; tick < 8; tick++) await state.run("s3");
      expect(s3Upload).toHaveBeenCalledTimes(1);
      expect(state.row("s3")?.["last_status"]).toBe("success");
      expect(state.row()?.["last_status"]).toBe("failed");
      client.directory.mockImplementationOnce(async () => {
        state.db.prepare("UPDATE cloud_backup_targets SET cron_cursor_json = '{}', locked_until = NULL, last_status = 'idle', last_error = NULL WHERE provider = 'webdav'").run();
        return null;
      });
      expect(await state.run()).toBe(false);
      expect(state.row()).toMatchObject({ cron_cursor_json: "{}", locked_until: null, last_status: "idle", last_error: null });
    } finally { state.db.close(); }
  });
});
