import { afterEach, describe, expect, it, vi } from "vitest";
import { createCronFixture, scheduledAt, settings } from "./cron-test-support";
import { CronBudget, CronBudgetExceeded } from "./cron-budget";
import { runScheduledCloudBackupForUser, updateCloudBackupConfig, readCloudBackupConfig } from "./cloud-backup";
import { WebDAVCloudBackupClient } from "./cloud-backup-remote";
import { WebDAVOperationLimitExceeded } from "./cloud-backup-webdav";
import { enqueueDueCronAccounts } from "./cron-progress";
import { cloudBackupConfigResponseSchema } from "@renewlet/shared/schemas/cloud-backup";

const auth = vi.hoisted(() => ({ userId: "" }));
vi.mock("./auth", () => ({ requireAuth: async () => ({ user: { id: auth.userId } }) }));
vi.mock("./smtp", () => ({ notificationSmtpConfig: vi.fn(), sendSmtpEmail: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(scheduledAt);
  const state = createCronFixture(2);
  const userId = state.ids[0] ?? ""; auth.userId = userId;
  const webdav = { url: "https://dav.example.test", username: "fixture-user", path: "backups" };
  const cursor = JSON.stringify({ id: "frozen", createdAt: scheduledAt.toISOString(), stage: "directory", after: null });
  for (const id of state.ids) for (const provider of ["webdav", "s3"]) {
    const config = provider === "webdav" ? { webdav } : { s3: { endpoint: "https://s3.example.test", bucket: "backups", region: "auto", prefix: "", accessKeyId: "fixture", addressingStyle: "pathStyle" } };
    state.db.prepare(`INSERT INTO cloud_backup_targets (user_id, provider, config_json, credential_json, schedule_enabled, last_backup_at, cron_cursor_json, next_run_at_utc, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, '2026-01-01T00:00:00.000Z', ?, ?, '', '')`).run(id, provider, JSON.stringify(config), JSON.stringify({ webdavPassword: "fixture-password", s3SecretAccessKey: "fixture" }), cursor, scheduledAt.toISOString());
  }
  const row = () => state.db.prepare("SELECT * FROM cloud_backup_targets WHERE user_id = ? AND provider = 'webdav'").get(userId);
  const run = (budget = new CronBudget()) => runScheduledCloudBackupForUser({ ...state.env, DB: budget.database(state.env.DB, 3) }, userId, "webdav", scheduledAt, scheduledAt, settings, budget, budget.database(state.env.DB));
  return { ...state, userId, webdav, cursor, row, run };
}

describe("WebDAV request limit pauses only the affected scheduled target", () => {
  it("persists a real transport limit, preserves its checkpoint, and resumes after saving an enabled policy", async () => {
    const state = fixture();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const hop = calls++ % 21;
      if (hop < 20) return new Response(null, { status: 307, headers: { location: "https://dav.example.test/backups" } });
      if (!new Headers(init?.headers).get("authorization")?.startsWith("Digest ")) return new Response(null, {
        status: 401, headers: { "www-authenticate": 'Digest realm="fixture", nonce="nonce", qop="auth"' },
      });
      return new Response(null, { status: 201 });
    }));
    try {
      const budget = new CronBudget();
      expect(await state.run(budget)).toBe(true);
      expect(calls).toBe(50); expect(budget.used.externalRequests).toBe(50);
      expect(state.row()).toMatchObject({ schedule_enabled: 0, next_run_at_utc: null, last_status: "failed", last_error: "CLOUD_BACKUP_WEBDAV_REQUEST_LIMIT",
        cron_cursor_json: state.cursor, last_backup_at: "2026-01-01T00:00:00.000Z", locked_until: null, cron_claim_token: null });
      expect(state.db.prepare("SELECT COUNT(*) AS count FROM cloud_backup_targets WHERE schedule_enabled = 1").get()?.["count"]).toBe(3);
      // 重新构造预算/业务环境模拟后续调用，不依赖isolate中的客户端或失败计数。
      for (let tick = 0; tick < 3; tick++) {
        const next = new CronBudget(); expect(await state.run(next)).toBe(true);
        expect(next.used.externalRequests).toBe(0); expect(next.used.sql).toBe(1);
      }
      expect(calls).toBe(50);
      const request = new Request("https://renewlet.example.test/api/app/cloud-backup/config");
      const paused = cloudBackupConfigResponseSchema.parse(await (await readCloudBackupConfig(request, state.env)).json()).data.config;
      expect(paused.policyByProvider.webdav.scheduleEnabled).toBe(false);
      expect(paused.statusByProvider.webdav.lastError).toBe("CLOUD_BACKUP_WEBDAV_REQUEST_LIMIT");
      expect(JSON.stringify(paused)).not.toContain("fixture-password");
      const saved = await updateCloudBackupConfig(new Request(request, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
        provider: "webdav", webdav: state.webdav,
        policy: { scheduleEnabled: true, scheduleFrequency: "daily", scheduleTime: "03:00", scheduleWeekday: "monday", retention: 2 },
      }) }), state.env);
      expect(saved.status).toBe(200);
      expect(state.row()).toMatchObject({ schedule_enabled: 1, cron_cursor_json: "{}" });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 201 })));
      await state.run(); await state.run();
      expect(state.row()?.["schedule_enabled"]).toBe(1);
      expect(JSON.parse(String(state.row()?.["cron_cursor_json"])).stage).toBe("prepare");
    } finally { state.db.close(); }
  });

  it("does not pause when earlier work used the invocation budget", async () => {
    const state = fixture();
    const directory = vi.spyOn(WebDAVCloudBackupClient.prototype, "prepareDirectory").mockRejectedValue(new CronBudgetExceeded("external"));
    try {
      await state.run();
      expect(state.row()).toMatchObject({ schedule_enabled: 1, cron_cursor_json: state.cursor, last_error: "CRON_EXTERNAL_BUDGET_EXCEEDED" });
      directory.mockResolvedValue(null); await state.run();
      expect(JSON.parse(String(state.row()?.["cron_cursor_json"])).stage).toBe("prepare");
    } finally { state.db.close(); }
  });

  it.each(["claim", "config"])("a late limit cannot pause a replacement %s", async (replacement) => {
    const state = fixture();
    vi.spyOn(WebDAVCloudBackupClient.prototype, "prepareDirectory").mockImplementation(async () => {
      state.db.prepare(replacement === "claim"
        ? "UPDATE cloud_backup_targets SET cron_claim_token = 'new-claim' WHERE user_id = ? AND provider = 'webdav'"
        : "UPDATE cloud_backup_targets SET cron_cursor_json = '{}', locked_until = NULL, cron_claim_token = NULL WHERE user_id = ? AND provider = 'webdav'").run(state.userId);
      throw new WebDAVOperationLimitExceeded();
    });
    try {
      expect(await state.run()).toBe(false);
      expect(state.row()).toMatchObject({ schedule_enabled: 1, last_error: null });
    } finally { state.db.close(); }
  });

  it("does not enqueue an account solely for a paused backup but still enqueues due reminders", async () => {
    const state = fixture();
    try {
      state.db.prepare("UPDATE subscription_scheduler_state SET auto_renew_count = 0, repeat_reminder_count = 0, next_daily_notification_due_at_utc = '2099-01-01T00:00:00Z'").run();
      state.db.prepare("UPDATE cloud_backup_targets SET schedule_enabled = 0, next_run_at_utc = NULL").run();
      await enqueueDueCronAccounts(state.env, scheduledAt);
      expect(state.db.prepare("SELECT COUNT(*) AS count FROM cron_progress").get()?.["count"]).toBe(0);
      state.db.prepare("UPDATE subscription_scheduler_state SET next_daily_notification_due_at_utc = ? WHERE user_id = ?").run(scheduledAt.toISOString(), state.userId);
      await enqueueDueCronAccounts(state.env, scheduledAt);
      expect(state.db.prepare("SELECT user_id FROM cron_progress").get()?.["user_id"]).toBe(state.userId);
    } finally { state.db.close(); }
  });
});
