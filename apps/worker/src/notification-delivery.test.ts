import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_CHANNELS } from "@renewlet/shared/runtime";
import { cronJobResultResponseSchema } from "@renewlet/shared/schemas/notifications";
import type { NotificationEmailMessage } from "@renewlet/shared/email-template";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { CronBudget, CronBudgetExceeded } from "./cron-budget";
import { createCronFixture, scheduledAt, settings } from "./cron-test-support";
import { runCronForUser } from "./notification-cron";
import { notificationSenders } from "./notification-channel-send";
import { createCronJobResult, createNotificationJob, finalizeNotificationJob, getNotificationJob, markNotificationJobSending } from "./notification-jobs";
import { checkpointNotificationDelivery, notificationDeliveryPending, readNotificationDelivery } from "./notification-delivery-storage";
import { readNotificationHistoryRows, notificationMessageParts } from "./notification-message-storage";
import { NotificationChannelError } from "./notification-errors";
import { scheduleOccurrence } from "./notification-schedule";

vi.mock("./smtp", () => ({ notificationSmtpConfig: vi.fn(), sendSmtpEmail: vi.fn() }));
const databases: ReturnType<typeof createCronFixture>["db"][] = [];
const schedule = scheduleOccurrence("2026-09-08", "08:00", "UTC");
const message: NotificationEmailMessage = { title: "Reminder", content: "冻结🌏正文\n".repeat(5000), timestamp: "08:00", hasPayload: true, items: [] };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(scheduledAt); });
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture(enabledChannels: ApiAppSettings["enabledChannels"] = [...NOTIFICATION_CHANNELS]) {
  const fixture = createCronFixture(2);
  databases.push(fixture.db);
  const userId = fixture.ids[0] ?? "";
  const build = vi.fn(() => structuredClone(message));
  const current: ApiAppSettings = { ...settings, enabledChannels };
  const run = (next = current, budget = new CronBudget()) => runCronForUser({ ...fixture.env, DB: budget.database(fixture.env.DB, 3) }, userId, next, schedule, new Date(), "en-US", build, budget);
  const job = async () => {
    const row = await getNotificationJob(fixture.env, userId, schedule);
    if (!row) throw new Error("Missing notification job");
    return row;
  };
  return { ...fixture, userId, build, current, run, job };
}

function deferred() {
  let resolve: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve: () => resolve() };
}

function stubChannels() {
  return NOTIFICATION_CHANNELS.map((channel) => vi.spyOn(notificationSenders, channel).mockResolvedValue(undefined));
}

describe("durable notification delivery rounds", () => {
  it("delivers all ten channels once across fresh invocations with one frozen snapshot and attempt", async () => {
    const senders = stubChannels();
    const f = fixture();
    for (let index = 0; index < NOTIFICATION_CHANNELS.length; index++) {
      const budget = new CronBudget();
      expect(await f.run(f.current, budget)).toBe(index === NOTIFICATION_CHANNELS.length - 1 ? "settled" : "keep_due");
      const row = await f.job();
      expect(row.attempts).toBe(1);
      expect(row.status).toBe(index === NOTIFICATION_CHANNELS.length - 1 ? "sent" : "pending");
      expect(budget.used.sql).toBeLessThanOrEqual(50);
      expect(senders.reduce((count, sender) => count + sender.mock.calls.length, 0)).toBe(index + 1);
      const history = await readNotificationHistoryRows(f.env, f.userId, "all", 1);
      const result = cronJobResultResponseSchema.parse(JSON.parse(history[0]?.result_json ?? "{}"));
      expect(result.message).toEqual(message);
      expect(result.channels.succeeded).toEqual(NOTIFICATION_CHANNELS.slice(0, index + 1));
      expect(result).not.toHaveProperty("deliveryPending");
      if (index === 0) {
        f.build.mockImplementation(() => { throw new Error("Must reuse frozen message"); });
        f.db.exec("CREATE TRIGGER freeze_message BEFORE DELETE ON notification_job_messages BEGIN SELECT RAISE(ABORT, 'snapshot rewritten'); END");
      }
      vi.setSystemTime(new Date(Date.now() + 60_000));
    }
    expect(f.build).toHaveBeenCalledOnce();
    for (const sender of senders) expect(sender.mock.calls[0]?.[0].message).toEqual(message);
    expect(notificationDeliveryPending(await f.job())).toBeNull();
  });

  it("retries only failed channels in three rounds and strips raw provider details", async () => {
    const success = vi.spyOn(notificationSenders, "telegram").mockResolvedValue(undefined);
    const failure = vi.spyOn(notificationSenders, "webhook").mockRejectedValue(new NotificationChannelError("provider unavailable", { rawResponseText: "must-not-persist" }));
    const f = fixture(["telegram", "webhook"]);
    expect(await f.run()).toBe("keep_due");
    expect(await f.run()).toBe("keep_due");
    expect(await f.run()).toBe("keep_due");
    expect(await f.run()).toBe("settled");
    expect(await f.run()).toBe("settled");
    expect(success).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledTimes(3);
    const row = await f.job();
    expect(row).toMatchObject({ status: "failed", attempts: 3 });
    expect(row.result_json).not.toContain("must-not-persist");
    expect(row.result_json).not.toContain("details");
  });

  it("drains the third round before marking it exhausted", async () => {
    stubChannels();
    const f = fixture(["telegram", "webhook"]);
    const result = createCronJobResult({ reason: "some_channels_failed", force: false, windowMinutes: 2, triggeredAtUtc: scheduledAt.toISOString(), schedule, settings: f.current, locale: "en-US", message,
      channels: { attempted: ["telegram", "webhook"], succeeded: [], failed: [{ channel: "telegram", error: "failed" }, { channel: "webhook", error: "failed" }] } });
    await finalizeNotificationJob(f.env, null, f.userId, schedule, "failed", 2, "failed", result);
    expect(await f.run()).toBe("keep_due");
    expect(await f.job()).toMatchObject({ status: "pending", attempts: 3 });
    expect(await f.run()).toBe("settled");
    expect(await f.job()).toMatchObject({ status: "sent", attempts: 3 });
  });

  it("drops disabled remaining channels without adding newly enabled ones to a started round", async () => {
    const senders = stubChannels();
    const f = fixture(["telegram", "webhook"]);
    await f.run();
    expect(await f.run({ ...f.current, localePreference: "zh-CN", enabledChannels: ["notifyx"] })).toBe("settled");
    expect(senders.reduce((count, sender) => count + sender.mock.calls.length, 0)).toBe(1);
    const saved = await readNotificationDelivery(f.env, await f.job());
    expect(saved?.result.settings.enabledChannels).toEqual(["telegram", "webhook"]);
    expect(saved?.result.channels.succeeded).toEqual(["telegram"]);
  });

  it("grants one pending claim even with eight contenders at the same millisecond", async () => {
    const senders = stubChannels();
    const f = fixture(["telegram", "webhook", "bark"]);
    await f.run();
    await Promise.all(Array.from({ length: 8 }, () => f.run()));
    expect(senders.reduce((count, sender) => count + sender.mock.calls.length, 0)).toBe(2);
    expect(await f.job()).toMatchObject({ status: "pending", attempts: 1 });
    expect(await f.run()).toBe("settled");
  });

  it("fences an old sender across stale recovery, preserves other successes and retries the unknown result", async () => {
    const entered = deferred();
    const release = deferred();
    const first = vi.spyOn(notificationSenders, "telegram").mockImplementationOnce(async () => { entered.resolve(); await release.promise; }).mockResolvedValue(undefined);
    const next = vi.spyOn(notificationSenders, "webhook").mockResolvedValue(undefined);
    const f = fixture(["telegram", "webhook"]);
    const old = f.run();
    await entered.promise;
    expect(await f.run()).toBe("keep_due");
    expect(first).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date(scheduledAt.getTime() + 16 * 60_000));
    expect(await f.run()).toBe("keep_due");
    expect(next).toHaveBeenCalledOnce();
    const recovered = await f.job();
    expect(recovered).toMatchObject({ status: "failed", attempts: 1 });
    expect(recovered.result_json).toContain("delivery_interrupted");
    release.resolve();
    expect(await old).toBe("keep_due");
    expect(await f.job()).toEqual(recovered);
    expect(await f.run()).toBe("settled");
    expect(first).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledOnce();
    expect(await f.job()).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("uses a new identity on each same-millisecond claim and rejects cross-owner reads or late metadata", async () => {
    stubChannels();
    const f = fixture(["telegram", "webhook", "bark"]);
    await f.run();
    const first = await markNotificationJobSending(f.env, await f.job(), 1);
    if (!first) throw new Error("Missing first claim");
    const saved = await readNotificationDelivery(f.env, first);
    if (!saved) throw new Error("Missing snapshot");
    expect(await checkpointNotificationDelivery(f.env, first, saved.result, ["webhook", "bark"], saved.chunkCount, "pending")).toBe(true);
    const second = await markNotificationJobSending(f.env, await f.job(), 1);
    expect(second?.updated_at).not.toBe(first.updated_at);
    expect(await checkpointNotificationDelivery(f.env, first, saved.result, [], saved.chunkCount, "sent")).toBe(false);
    expect(await readNotificationDelivery(f.env, { ...first, user_id: f.ids[1] ?? "" })).toBeNull();
  });

  it("never sends before the snapshot commits, and rolls back failed channel checkpoints", async () => {
    const sender = vi.spyOn(notificationSenders, "telegram").mockResolvedValue(undefined);
    const f = fixture(["telegram", "webhook"]);
    f.db.exec("CREATE TRIGGER fail_snapshot BEFORE UPDATE OF result_json ON notification_jobs BEGIN SELECT RAISE(ABORT, 'snapshot failure'); END");
    await expect(f.run()).rejects.toThrow("snapshot failure");
    expect(sender).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM notification_job_messages").get()?.["n"]).toBe(0);
    f.db.exec("DROP TRIGGER fail_snapshot");
    vi.setSystemTime(new Date(scheduledAt.getTime() + 16 * 60_000));
    f.db.exec("CREATE TRIGGER fail_result BEFORE UPDATE ON notification_jobs WHEN NEW.status = 'pending' BEGIN SELECT RAISE(ABORT, 'result failure'); END");
    await expect(f.run()).rejects.toThrow("result failure");
    expect(sender).toHaveBeenCalledOnce();
    expect(await f.job()).toMatchObject({ status: "sending", attempts: 2 });
    expect(notificationDeliveryPending(await f.job())).toEqual(["telegram", "webhook"]);
  });

  it("rejects insufficient SQL or a partially used external budget before claiming", async () => {
    const sender = vi.spyOn(notificationSenders, "telegram").mockResolvedValue(undefined);
    const f = fixture(["telegram"]);
    const sql = new CronBudget(); sql.consumeSql(45);
    await expect(f.run(f.current, sql)).rejects.toThrow("CRON_SQL_BUDGET_EXCEEDED");
    const external = new CronBudget(); external.consumeExternalRequest();
    await expect(f.run(f.current, external)).rejects.toThrow("CRON_EXTERNAL_BUDGET_EXCEEDED");
    expect(sender).not.toHaveBeenCalled();
    expect(await getNotificationJob(f.env, f.userId, schedule)).toBeNull();
  });

  it("records an over-limit single-channel failure while preserving prior success and remaining channels", async () => {
    vi.spyOn(notificationSenders, "telegram").mockResolvedValue(undefined);
    vi.spyOn(notificationSenders, "webhook").mockRejectedValue(new CronBudgetExceeded("external"));
    vi.spyOn(notificationSenders, "bark").mockResolvedValue(undefined);
    const f = fixture(["telegram", "webhook", "bark"]);
    await f.run(); await f.run();
    expect(await f.job()).toMatchObject({ status: "pending", attempts: 1 });
    await f.run();
    expect((await readNotificationDelivery(f.env, await f.job()))?.result.channels).toEqual({
      attempted: ["telegram", "webhook", "bark"], succeeded: ["telegram", "bark"], failed: [{ channel: "webhook", error: "CRON_EXTERNAL_BUDGET_EXCEEDED" }],
    });
  });

  it.each([["telegram", "telegram"], ["unknown"], [], "webhook"].map((invalid) => ({ invalid })))("rejects corrupt private progress $invalid without sending", async ({ invalid }) => {
    stubChannels();
    const f = fixture(["telegram", "webhook"]);
    await f.run();
    const row = await f.job();
    const metadata = JSON.parse(row.result_json) as Record<string, unknown>;
    f.db.prepare("UPDATE notification_jobs SET result_json = ?").run(JSON.stringify({ ...metadata, deliveryPending: invalid }));
    await expect(f.run()).rejects.toThrow();
    expect(notificationSenders.webhook).not.toHaveBeenCalled();
  });

  it("commits a prepared snapshot only while its claim still owns the job", async () => {
    const f = fixture(["telegram"]);
    const { row } = await createNotificationJob(f.env, f.userId, schedule, "sending", 1);
    if (!row) throw new Error("Missing claim");
    await markNotificationJobSending(f.env, row, 2);
    const result = createCronJobResult({ reason: null, force: false, windowMinutes: 2, triggeredAtUtc: scheduledAt.toISOString(), schedule, settings: f.current, locale: "en-US", message, channels: { attempted: [], succeeded: [], failed: [] } });
    const parts = notificationMessageParts(message);
    expect(await checkpointNotificationDelivery(f.env, row, result, ["telegram"], parts.length, "sending", parts)).toBe(false);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM notification_job_messages").get()?.["n"]).toBe(0);
  });
});
