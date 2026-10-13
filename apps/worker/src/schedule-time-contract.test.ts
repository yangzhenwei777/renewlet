import { describe, expect, it, vi } from "vitest";
import { notificationScheduleFixtures } from "@renewlet/shared/contract-fixtures";
import { cloudBackupPolicySchema } from "@renewlet/shared/schemas/cloud-backup";
import { appSettingsSchema } from "@renewlet/shared/schemas/settings";
import { createCronFixture, settings } from "./cron-test-support";
import { scheduleOccurrence } from "./notification-schedule";
import { cloudBackupNextRunAt, cloudBackupTargetDue } from "./cloud-backup-schedule";
import { runScheduledForUser } from "./notifications";
import { CronBudget } from "./cron-budget";

vi.mock("./smtp", () => ({ notificationSmtpConfig: vi.fn(), sendSmtpEmail: vi.fn() }));
const fixtures = notificationScheduleFixtures.filter((fixture) => fixture.expected.nextDailyInstantUtc);

describe("shared wall-clock policy across reminders and backups", () => {
  it.each(fixtures)("preserves the original local job key and instant for $name", async (fixture) => {
    const { db, env, ids } = createCronFixture(1);
    const userId = ids[0] ?? "";
    const configured = appSettingsSchema.parse({ ...settings, ...fixture.settings, enabledChannels: [] });
    const now = new Date(fixture.nowUtc);
    try {
      db.prepare("UPDATE settings SET settings_json = ?").run(JSON.stringify(configured));
      await runScheduledForUser(env, userId, now, { settings: configured, leaseNow: now, budget: new CronBudget() });
      const job = db.prepare("SELECT scheduled_local_date, scheduled_local_time, time_zone, scheduled_instant_utc FROM notification_jobs").get();
      if (fixture.expected.due) expect(job).toEqual({
        scheduled_local_date: fixture.expected.scheduledLocalDate,
        scheduled_local_time: fixture.expected.scheduledLocalTime,
        time_zone: fixture.expected.timeZone,
        scheduled_instant_utc: fixture.expected.scheduledInstantUtc,
      });
      else expect(job).toBeUndefined();
      expect(db.prepare("SELECT next_daily_notification_due_at_utc FROM subscription_scheduler_state").get()?.["next_daily_notification_due_at_utc"])
        .toBe(fixture.expected.nextDailyInstantUtc);
    } finally { db.close(); }
  });

  it.each(fixtures)("backs up at the same instant and advances after success for $name", (fixture) => {
    const now = new Date(fixture.nowUtc);
    const policy = cloudBackupPolicySchema.parse({ scheduleEnabled: true, scheduleTime: fixture.settings.notificationTimeLocal });
    const target = { policy, lastBackupAt: null };
    expect(cloudBackupTargetDue(target, fixture.settings.timezone, now)).toBe(true);
    expect(cloudBackupNextRunAt(target, fixture.settings.timezone, now)).toBe(new Date(fixture.expected.scheduledInstantUtc ?? "").toISOString());
    const completed = { policy, lastBackupAt: fixture.expected.scheduledInstantUtc ?? null };
    expect(cloudBackupTargetDue(completed, fixture.settings.timezone, now)).toBe(false);
    expect(cloudBackupNextRunAt(completed, fixture.settings.timezone, now)).toBe(new Date(fixture.expected.nextDailyInstantUtc ?? "").toISOString());
    expect(scheduleOccurrence(fixture.expected.scheduledLocalDate ?? "", fixture.settings.notificationTimeLocal, fixture.settings.timezone).scheduledInstantUtc)
      .toBe(fixture.expected.scheduledInstantUtc);
  });
});
