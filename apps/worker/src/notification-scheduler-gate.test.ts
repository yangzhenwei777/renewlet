import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runScheduledForUser } from "./notifications";
import type { Env } from "./types";
import { notificationSenders } from "./notification-channel-send";
import { subscriptionRow } from "./subscription-d1-test-support";

vi.mock("./smtp", () => ({
  notificationSmtpConfig: () => {
    throw new Error("SMTP should not be used by notification scheduler gate tests");
  },
  sendSmtpEmail: async () => undefined,
}));

type FakeD1Query = {
  sql: string;
  params: unknown[];
  method: "all" | "first" | "run";
};

function fakeEnv(handler: (query: FakeD1Query) => unknown | Promise<unknown>): Env {
  return {
    DB: {
      async batch(statements: D1PreparedStatement[]) {
        const results: D1Result[] = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        return results;
      },
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              all: async () => await handler({ sql, params, method: "all" }),
              first: async () => await handler({ sql, params, method: "first" }),
              run: async () => await handler({ sql, params, method: "run" }),
            } as D1PreparedStatement;
          },
        } as D1PreparedStatement;
      },
    } as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
  };
}

function d1All<T>(results: T[]): D1Result<T> {
  return { results, success: true, meta: {} as D1Meta } as D1Result<T>;
}

function d1Run(changes = 0): D1Result {
  return { results: [], success: true, meta: { changes } } as unknown as D1Result;
}

function settings(overrides: Partial<ApiAppSettings> = {}): ApiAppSettings {
  return {
    ...createDefaultAppSettings(),
    timezone: "UTC",
    notificationTimeLocal: "08:00" as ApiAppSettings["notificationTimeLocal"],
    ...overrides,
  };
}

function schedulerState(repeatReminderCount: number) {
  return {
    user_id: "usr_due",
    auto_renew_count: 0,
    repeat_reminder_count: repeatReminderCount,
    last_auto_renew_local_date: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Cloudflare notification scheduler gate", () => {
  it.each(["claim", "snapshot", "finalize", "skip"])("keeps the due state after losing the %s race", async (phase) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-09T08:00:00.000Z"));
    const sender = vi.spyOn(notificationSenders, "webhook").mockResolvedValue(undefined);
    let dueWrites = 0;
    let finalizations = 0;
    const env = fakeEnv(({ sql, method }) => {
      if (method === "all" && sql.includes("FROM subscription_scheduler_state AS scheduler")) return d1All([{ user_id: "usr_due" }]);
      if (method === "first" && sql.includes("SELECT settings_json FROM settings")) return { settings_json: JSON.stringify(settings({ enabledChannels: phase === "skip" ? [] : ["webhook"] })) };
      if (method === "first" && sql.includes("FROM subscription_scheduler_state")) return { ...schedulerState(0), auto_renew_count: 0 };
      if (method === "all" && sql.includes("FROM subscriptions")) return d1All([subscriptionRow("sub_due", { user_id: "usr_due", start_date: "2026-01-01", next_billing_date: "2026-01-10", reminder_days: 1 })]);
      if (method === "first" && sql.includes("FROM notification_jobs")) return {
        id: "job_due", user_id: "usr_due", status: "failed", attempts: 1,
        scheduled_local_date: "2026-01-09", scheduled_local_time: "08:00", time_zone: "UTC", scheduled_instant_utc: "2026-01-09T08:00:00Z",
        created_at: "2026-01-09T08:00:00Z", updated_at: "2026-01-09T08:00:00Z", last_error: "old failure",
        result_json: JSON.stringify({ source: "cron", channels: { attempted: ["webhook"], succeeded: [], failed: [{ channel: "webhook", error: "old failure" }] } }),
      };
      if (method === "run" && sql.includes("SET status = 'sending'")) return d1Run(phase === "claim" ? 0 : 1);
      if (method === "run" && sql.includes("notification_job_messages")) return d1Run(0);
      if (method === "run" && sql.includes("UPDATE notification_jobs")) { finalizations++; return d1Run(phase === "finalize" && finalizations === 1 ? 1 : 0); }
      if (method === "run" && sql.includes("subscription_scheduler_state")) { dueWrites++; return d1Run(1); }
      if (method === "first" && sql.includes("SUM(CASE WHEN auto_renew")) return { auto_renew_count: 0, repeat_reminder_count: 0 };
      throw new Error(`unexpected ${method} query: ${sql}`);
    });
    const error = vi.spyOn(console, "error");
    await runScheduledForUser(env, "usr_due");
    expect(error).not.toHaveBeenCalled();
    expect(sender).toHaveBeenCalledTimes(phase === "finalize" ? 1 : 0);
    expect(finalizations).toBe(phase === "claim" ? 0 : phase === "finalize" ? 2 : 1);
    expect(dueWrites).toBe(0);
  });

  it("uses repeat candidates without full subscription scans when repeat gate is present", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-09T07:00:00.000Z"));
    const subscriptionQueries: string[] = [];
    const env = fakeEnv(({ sql, method }) => {
      if (method === "all" && sql.includes("FROM subscription_scheduler_state AS scheduler")) return d1All([{ user_id: "usr_due" }]);
      if (method === "first" && sql.includes("SELECT settings_json FROM settings")) {
        return { settings_json: JSON.stringify(settings()) };
      }
      if (method === "first" && sql.includes("FROM subscription_scheduler_state")) return schedulerState(1);
      if (method === "first" && sql.includes("SUM(CASE WHEN auto_renew")) return { auto_renew_count: 0, repeat_reminder_count: 1 };
      if (method === "run" && sql.includes("subscription_scheduler_state")) return d1Run(1);
      if (method === "all" && sql.includes("FROM subscriptions")) {
        subscriptionQueries.push(sql);
        return d1All([]);
      }
      throw new Error(`unexpected ${method} query: ${sql}`);
    });

    await expect(runScheduledForUser(env, "usr_due")).resolves.toEqual(expect.objectContaining({ outcome: expect.any(String) }));

    expect(subscriptionQueries).toHaveLength(1);
    expect(subscriptionQueries[0]).toContain("repeat_reminder_enabled = 1");
    expect(subscriptionQueries[0]).not.toContain("auto_renew = 1");
    expect(subscriptionQueries[0]).not.toMatch(/WHERE user_id = \?\s+ORDER BY created_at DESC, id DESC\s+LIMIT \?/s);
  });

  it("settles max-retried failed jobs by refreshing mirrors and scheduler state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-09T08:00:00.000Z"));
    let mirrorRefreshCount = 0;
    let schedulerRefreshCount = 0;
    const env = fakeEnv(({ sql, method }) => {
      if (method === "all" && sql.includes("FROM subscription_scheduler_state AS scheduler")) return d1All([{ user_id: "usr_due" }]);
      if (method === "first" && sql.includes("SELECT settings_json FROM settings")) {
        return { settings_json: JSON.stringify(settings({ enabledChannels: ["webhook"] })) };
      }
      if (method === "first" && sql.includes("FROM subscription_scheduler_state")) return schedulerState(0);
      if (method === "all" && sql.includes("UNION") && sql.includes("cost_sharing_next_collection_reminder_date")) return d1All([]);
      if (method === "first" && sql.includes("FROM notification_jobs")) {
        return {
          id: "job_due",
          user_id: "usr_due",
          scheduled_local_date: "2026-01-09",
          scheduled_local_time: "08:00",
          time_zone: "UTC",
          scheduled_instant_utc: "2026-01-09T08:00:00Z",
          status: "failed",
          attempts: 3,
          last_error: "webhook: failed",
          result_json: JSON.stringify({ source: "cron", channels: { attempted: ["webhook"], succeeded: [], failed: [{ channel: "webhook", error: "failed" }] } }),
          created_at: "2026-01-09T08:00:00Z",
          updated_at: "2026-01-09T08:00:00Z",
        };
      }
      if (method === "all" && sql.includes("SELECT id, user_id") && sql.includes("FROM subscriptions WHERE user_id = ?")) {
        mirrorRefreshCount += 1;
        return d1All([]);
      }
      if (method === "first" && sql.includes("SUM(CASE WHEN auto_renew")) return { auto_renew_count: 0, repeat_reminder_count: 0 };
      if (method === "run" && sql.includes("subscription_scheduler_state")) {
        schedulerRefreshCount += 1;
        return d1Run(1);
      }
      throw new Error(`unexpected ${method} query: ${sql}`);
    });

    await expect(runScheduledForUser(env, "usr_due")).resolves.toEqual(expect.objectContaining({ outcome: expect.any(String) }));

    expect(mirrorRefreshCount).toBe(1);
    expect(schedulerRefreshCount).toBe(1);
  });
});
