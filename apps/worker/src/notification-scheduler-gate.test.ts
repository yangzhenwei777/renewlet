import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runScheduledNotifications } from "./notifications";
import { listNotificationDueUsers } from "./subscription-scheduler-state";
import type { Env } from "./types";

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
});

describe("Cloudflare notification scheduler gate", () => {
  it("pages past retained due users by excluding users already handled in the same tick", async () => {
    const queries: FakeD1Query[] = [];
    const env = fakeEnv((query) => {
      queries.push(query);
      if (query.method === "all" && query.sql.includes("FROM subscription_scheduler_state AS scheduler")) {
        return d1All([{ user_id: "usr_later" }]);
      }
      throw new Error(`unexpected ${query.method} query: ${query.sql}`);
    });

    const users = await listNotificationDueUsers(env, new Date("2026-01-09T08:00:00.000Z"), 1, ["usr_retained"]);

    expect(users).toEqual([{ user_id: "usr_later" }]);
    expect(queries[0]?.sql).toContain("scheduler.user_id NOT IN (?)");
    expect(queries[0]?.params).toEqual(["2026-01-09T08:00:00Z", "2026-01-09T08:00:00Z", "usr_retained", 1]);
  });

  it("skips non-due scheduled ticks without subscription candidate scans when repeat gate is empty", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-09T07:00:00.000Z"));
    const subscriptionQueries: string[] = [];
    const env = fakeEnv(({ sql, method }) => {
      if (method === "all" && sql.includes("FROM subscription_scheduler_state AS scheduler")) return d1All([]);
      if (method === "first" && sql.includes("SELECT settings_json FROM settings")) {
        return { settings_json: JSON.stringify(settings()) };
      }
      if (method === "first" && sql.includes("FROM subscription_scheduler_state")) return schedulerState(0);
      if (method === "all" && sql.includes("FROM subscriptions")) {
        subscriptionQueries.push(sql);
        return d1All([]);
      }
      throw new Error(`unexpected ${method} query: ${sql}`);
    });

    await expect(runScheduledNotifications(env)).resolves.toBeUndefined();

    expect(subscriptionQueries).toHaveLength(0);
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

    await expect(runScheduledNotifications(env)).resolves.toBeUndefined();

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

    await expect(runScheduledNotifications(env)).resolves.toBeUndefined();

    expect(mirrorRefreshCount).toBe(1);
    expect(schedulerRefreshCount).toBe(1);
  });
});
