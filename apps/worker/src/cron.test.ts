import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCronTick } from "./cron";
import { createCronFixture, scheduledAt, settings } from "./cron-test-support";
import { subscriptionDerivedBulkMutationPlan } from "./subscription-derived-state";
import { subscriptionRow } from "./subscription-d1-test-support";
import { notificationSenders } from "./notification-channel-send";

vi.mock("./smtp", () => ({ notificationSmtpConfig: vi.fn(), sendSmtpEmail: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("durable Cron account pipeline", () => {
  it.each([1, 20])("processes %i accounts with 1000 subscriptions without losing late notifications", async (size) => {
    vi.useFakeTimers();
    vi.setSystemTime(scheduledAt);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sender = vi.spyOn(notificationSenders, "webhook").mockResolvedValue(undefined);
    const { db, env, ids } = createCronFixture(size);
    try {
      const enabled = { ...settings, enabledChannels: ["webhook"], webhookUrl: "https://example.test/notify" };
      for (const userId of ids) {
        db.prepare("UPDATE settings SET settings_json = ? WHERE user_id = ?").run(JSON.stringify(enabled), userId);
        for (let start = 0; start < 1000; start += 100) {
          const mutations = Array.from({ length: 100 }, (_, index) => ({
            before: null,
            after: subscriptionRow(`${userId}-sub-${String(start + index).padStart(4, "0")}`, {
              user_id: userId, start_date: "2026-08-01", next_billing_date: start + index === 999 ? "2026-09-11" : "2026-08-01", auto_renew: start + index === 999 ? 0 : 1,
            }),
            kind: "create" as const,
          }));
          const plan = subscriptionDerivedBulkMutationPlan(env, mutations, settings, scheduledAt);
          await env.DB.batch([...plan.beforeFact, plan.fact, ...plan.afterFact]);
        }
      }
      const tickCpuMicros: number[] = [];
      let ticks = 0;
      for (; ticks < size * 30; ticks++) {
        const now = new Date(scheduledAt.getTime() + ticks * 60_000);
        vi.setSystemTime(now);
        const cpuBefore = process.cpuUsage();
        await runCronTick(env, now);
        const cpu = process.cpuUsage(cpuBefore);
        tickCpuMicros.push(cpu.user + cpu.system);
        const jobs = Number(db.prepare("SELECT COUNT(*) AS n FROM notification_jobs WHERE status = 'sent'").get()?.["n"]);
        const pending = Number(db.prepare("SELECT COUNT(*) AS n FROM cron_progress").get()?.["n"]);
        if (jobs === size && pending === 0) break;
      }
      expect(error).not.toHaveBeenCalled();
      expect(ticks, JSON.stringify({ jobs: db.prepare("SELECT status, COUNT(*) AS n FROM notification_jobs GROUP BY status").all(), progress: db.prepare("SELECT phase, COUNT(*) AS n FROM cron_progress GROUP BY phase").all(), state: db.prepare("SELECT * FROM subscription_scheduler_state LIMIT 1").get() })).toBeLessThan(size * 30);
      await runCronTick(env, new Date(scheduledAt.getTime() + (ticks + 1) * 60_000));
      expect(db.prepare("SELECT COUNT(*) AS n FROM cron_progress").get()?.["n"]).toBe(0);
      expect(sender).toHaveBeenCalledTimes(size);
      for (const [context] of sender.mock.calls) {
        expect(context.message.items).toHaveLength(1);
        expect(context.message.items?.[0]?.subscriptionId).toMatch(/sub-0999$/);
      }
      const jobs = db.prepare("SELECT scheduled_instant_utc, scheduled_local_date, scheduled_local_time, time_zone, attempts FROM notification_jobs").all();
      expect(jobs).toHaveLength(size);
      for (const job of jobs) expect(job).toMatchObject({ scheduled_instant_utc: "2026-09-08T08:00:00Z", scheduled_local_date: "2026-09-08", scheduled_local_time: "08:00", time_zone: "UTC", attempts: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE auto_renew = 1 AND next_billing_date = '2026-10-01'").get()?.["n"]).toBe(size * 999);
      const resources = info.mock.calls.filter(([event]) => event === "cron_resources").map(([, value]) => value as { sql: number; externalReserved: number });
      expect(resources).toHaveLength(ticks + 2);
      expect(Math.max(...resources.map((item) => item.sql))).toBeLessThanOrEqual(50);
      expect(Math.max(...resources.map((item) => item.externalReserved))).toBeLessThanOrEqual(50);
      process.stdout.write(`${JSON.stringify({ environment: "Node + SQLite (not workerd or cloud)", accounts: size, subscriptionsPerAccount: 1000, ticks: ticks + 1, maxSql: Math.max(...resources.map((item) => item.sql)), maxExternalReserved: Math.max(...resources.map((item) => item.externalReserved)), processCpuMicrosPerTick: { max: Math.max(...tickCpuMicros), mean: Math.round(tickCpuMicros.reduce((sum, value) => sum + value, 0) / tickCpuMicros.length) }, endProcessMemory: process.memoryUsage() })}\n`);
    } finally { db.close(); }
  }, 120_000);

  it("spends only cleanup, enqueue and claim queries when no account is due", async () => {
    const { db, env } = createCronFixture(1);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await runCronTick(env, new Date("2026-09-08T07:00:00Z"));
      expect(info).toHaveBeenCalledWith("cron_resources", { event: "cron_resources", phase: "idle", sql: 3, externalReserved: 0, externalRequests: 0, storageReserved: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM cron_progress").get()?.["n"]).toBe(0);
    } finally { db.close(); }
  });

  it("continues account work when staged object cleanup fails without logging provider details", async () => {
    const { db, env } = createCronFixture(1);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      db.prepare("INSERT INTO cloud_backup_staging (r2_key, created_at) VALUES (?, '')").run(`system/cloud-backup-staging/${crypto.randomUUID()}`);
      env.ASSETS_BUCKET = { delete: vi.fn().mockRejectedValue(new Error("Bearer fixture-secret")) } as unknown as R2Bucket;
      await runCronTick(env, scheduledAt);
      expect(db.prepare("SELECT phase FROM cron_progress").get()?.["phase"]).toBe("notification");
      expect(error).toHaveBeenCalledWith("cloud_backup_staging_cleanup_failed", { event: "cloud_backup_staging_cleanup_failed", error: { name: "Error" } });
      expect(JSON.stringify(error.mock.calls)).not.toContain("fixture-secret");
      expect(db.prepare("SELECT count(*) AS count FROM cloud_backup_staging").get()?.["count"]).toBe(1);
    } finally { db.close(); }
  });

  it("keeps a failed renewal before notification while allowing another account to proceed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(scheduledAt);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db, env, ids } = createCronFixture(2);
    try {
      const first = ids[0];
      const second = ids[1];
      if (!first || !second) throw new Error("Missing accounts");
      const plan = subscriptionDerivedBulkMutationPlan(env, [{ before: null, after: subscriptionRow("renew-me", { user_id: first, auto_renew: 1, start_date: "2026-08-01", next_billing_date: "2026-08-01" }), kind: "create" }], settings, scheduledAt);
      await env.DB.batch([...plan.beforeFact, plan.fact, ...plan.afterFact]);
      db.exec("CREATE TRIGGER fail_renewal BEFORE UPDATE OF next_billing_date ON subscriptions BEGIN SELECT RAISE(ABORT, 'fixture Authorization: Bearer secret'); END");
      await runCronTick(env, scheduledAt);
      expect(db.prepare("SELECT phase FROM cron_progress WHERE user_id = ?").get(first)?.["phase"]).toBe("renewal");
      expect(db.prepare("SELECT COUNT(*) AS n FROM notification_jobs").get()?.["n"]).toBe(0);
      await runCronTick(env, new Date(scheduledAt.getTime() + 60_000));
      expect(db.prepare("SELECT phase FROM cron_progress WHERE user_id = ?").get(second)?.["phase"]).toBe("notification");
      expect(error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(error.mock.calls)).not.toContain("secret");
      db.exec("DROP TRIGGER fail_renewal");
      await runCronTick(env, new Date(scheduledAt.getTime() + 2 * 60_000));
      expect(db.prepare("SELECT phase FROM cron_progress WHERE user_id = ?").get(first)?.["phase"]).toBe("notification");
    } finally { db.close(); }
  });
});
