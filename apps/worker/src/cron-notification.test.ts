import { afterEach, describe, expect, it, vi } from "vitest";
import { createCronFixture, scheduledAt, settings } from "./cron-test-support";
import { CronBudget } from "./cron-budget";
import { createCronJobResult, createNotificationJob, failExhaustedNotificationJob, finalizeNotificationJob } from "./notification-jobs";
import { scheduleOccurrence, getNextLocalScheduleOccurrence } from "./notification-schedule";
import { notificationSenders } from "./notification-channel-send";
import { runScheduledForUser } from "./notifications";
import { subscriptionDerivedBulkMutationPlan } from "./subscription-derived-state";
import { subscriptionRow } from "./subscription-d1-test-support";

vi.mock("./smtp", () => ({ notificationSmtpConfig: vi.fn(), sendSmtpEmail: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("notification continuation boundaries", () => {
  it.each(["daily", "repeat"])("advances the completed %s window strictly while preview remains inclusive", async (kind) => {
    vi.useFakeTimers();
    const now = kind === "daily" ? scheduledAt : new Date("2026-09-08T09:00:00Z");
    vi.setSystemTime(now);
    const { db, env, ids } = createCronFixture(1);
    const userId = ids[0] ?? "";
    try {
      const plan = subscriptionDerivedBulkMutationPlan(env, [{ before: null, after: subscriptionRow("repeat", {
        user_id: userId, start_date: "2026-09-01", next_billing_date: "2026-09-11", reminder_days: 3,
        repeat_reminder_enabled: 1, repeat_reminder_interval: "1h", repeat_reminder_window: "full",
      }), kind: "create" }], settings, now);
      await env.DB.batch([...plan.beforeFact, plan.fact, ...plan.afterFact]);
      expect(getNextLocalScheduleOccurrence(scheduledAt, "UTC", "08:00").scheduledInstantUtc).toBe("2026-09-08T08:00:00Z");
      const result = await runScheduledForUser(env, userId, now, { settings, leaseNow: now, budget: new CronBudget() });
      expect(result.outcome).toBe("settled");
      expect(db.prepare("SELECT next_daily_notification_due_at_utc, next_repeat_notification_due_at_utc FROM subscription_scheduler_state").get()).toMatchObject({
        next_daily_notification_due_at_utc: "2026-09-09T08:00:00Z",
        next_repeat_notification_due_at_utc: kind === "daily" ? "2026-09-08T09:00:00Z" : "2026-09-08T10:00:00Z",
      });
    } finally { db.close(); }
  });

  it("settles exhausted stale sending without sending or losing its snapshot, rejecting late completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(scheduledAt);
    const sender = vi.spyOn(notificationSenders, "webhook").mockResolvedValue(undefined);
    const { db, env, ids } = createCronFixture(1);
    const userId = ids[0] ?? "";
    const occurrence = scheduleOccurrence("2026-09-08", "08:00", "UTC");
    try {
      const created = await createNotificationJob(env, userId, occurrence, "sending", 3);
      if (!created.row) throw new Error("Missing job");
      const snapshot = JSON.stringify({ source: "cron", channels: { attempted: ["webhook"], succeeded: ["webhook"], failed: [] } });
      db.prepare("UPDATE notification_jobs SET result_json = ?").run(snapshot);
      const later = new Date(scheduledAt.getTime() + 16 * 60_000);
      vi.setSystemTime(later);
      expect((await runScheduledForUser(env, userId, scheduledAt, { settings, leaseNow: later, budget: new CronBudget() })).outcome).toBe("settled");
      expect(sender).not.toHaveBeenCalled();
      expect(db.prepare("SELECT status, attempts, result_json, last_error FROM notification_jobs").get()).toMatchObject({ status: "failed", attempts: 3, result_json: snapshot, last_error: "max_retries_reached" });
      expect(await finalizeNotificationJob(env, created.row, userId, occurrence, "sent", 3, null, createCronJobResult({ reason: null, force: false, windowMinutes: 2, triggeredAtUtc: later.toISOString(), schedule: occurrence, settings, locale: "en-US", message: { title: "Reminder", content: "", timestamp: "", hasPayload: false, items: [] }, channels: { attempted: [], succeeded: [], failed: [] } }))).toBe(false);
      expect(await failExhaustedNotificationJob(env, created.row)).toBe(false);
    } finally { db.close(); }
  });

  it.each([40, 41])("reserves final persistence before sending with %i SQL calls already spent", async (spent) => {
    vi.useFakeTimers(); vi.setSystemTime(scheduledAt);
    const sender = vi.spyOn(notificationSenders, "webhook").mockResolvedValue(undefined);
    const { db, env, ids } = createCronFixture(1);
    const userId = ids[0] ?? "";
    const enabled = { ...settings, enabledChannels: ["webhook" as const], webhookUrl: "https://example.test/notify" };
    try {
      db.prepare("UPDATE settings SET settings_json = ?").run(JSON.stringify(enabled));
      const plan = subscriptionDerivedBulkMutationPlan(env, [{ before: null, after: subscriptionRow("due", { user_id: userId, start_date: "2026-09-01", next_billing_date: "2026-09-11", reminder_days: 3 }), kind: "create" }], enabled, scheduledAt);
      await env.DB.batch([...plan.beforeFact, plan.fact, ...plan.afterFact]);
      const run = (budget: CronBudget) => runScheduledForUser({ ...env, DB: budget.database(env.DB, 3) }, userId, scheduledAt, { settings: enabled, leaseNow: scheduledAt, budget });
      const budget = new CronBudget(); budget.consumeSql(spent);
      await expect(run(budget)).rejects.toThrow("CRON_SQL_BUDGET_EXCEEDED");
      if (spent === 40) {
        expect(sender).toHaveBeenCalledTimes(1);
        expect(db.prepare("SELECT status FROM notification_jobs").get()?.["status"]).toBe("sent");
      } else {
        expect(sender).not.toHaveBeenCalled();
        expect(db.prepare("SELECT COUNT(*) AS n FROM notification_jobs").get()?.["n"]).toBe(0);
      }
      expect((await run(new CronBudget())).outcome).toBe("settled");
      expect(sender).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });

  it("resumes a failed due-index checkpoint without resending the committed message", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(scheduledAt);
    const sender = vi.spyOn(notificationSenders, "webhook").mockResolvedValue(undefined);
    const { db, env, ids } = createCronFixture(1);
    const userId = ids[0] ?? "";
    const enabled = { ...settings, enabledChannels: ["webhook" as const], webhookUrl: "https://example.test/notify" };
    try {
      db.prepare("UPDATE settings SET settings_json = ?").run(JSON.stringify(enabled));
      const plan = subscriptionDerivedBulkMutationPlan(env, [{ before: null, after: subscriptionRow("due", { user_id: userId, start_date: "2026-09-01", next_billing_date: "2026-09-11", reminder_days: 3 }), kind: "create" }], enabled, scheduledAt);
      await env.DB.batch([...plan.beforeFact, plan.fact, ...plan.afterFact]);
      db.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON subscription_scheduler_state BEGIN SELECT RAISE(ABORT, 'interrupted checkpoint'); END");
      const run = () => { const budget = new CronBudget(); return runScheduledForUser({ ...env, DB: budget.database(env.DB, 3) }, userId, scheduledAt, { settings: enabled, leaseNow: scheduledAt, budget }); };
      await expect(run()).rejects.toThrow("interrupted checkpoint");
      expect(db.prepare("SELECT status FROM notification_jobs").get()?.["status"]).toBe("sent");
      db.exec("DROP TRIGGER fail_checkpoint");
      expect((await run()).outcome).toBe("settled");
      expect(sender).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });
});
