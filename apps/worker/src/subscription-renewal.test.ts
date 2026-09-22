import { describe, expect, it } from "vitest";
import { renewAutoSubscriptionsForAllUsers } from "./subscription-renewal";
import type { Env } from "./types";

type FakeD1Query = {
  sql: string;
  params: unknown[];
  method: "all" | "first" | "run";
};

function fakeEnv(handler: (query: FakeD1Query) => unknown | Promise<unknown>): Env {
  return {
    DB: {
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

describe("Cloudflare subscription renewal scheduler", () => {
  it("skips settings and subscription candidate queries when auto-renew gate is empty", async () => {
    const settingsQueries: string[] = [];
    const subscriptionQueries: string[] = [];
    const env = fakeEnv(({ sql, method }) => {
      if (method === "all" && sql.includes("FROM subscription_scheduler_state AS scheduler")) {
        return d1All([]);
      }
      if (method === "first" && sql.includes("FROM subscription_scheduler_state")) {
        return {
          user_id: "usr_idle",
          auto_renew_count: 0,
          repeat_reminder_count: 0,
          last_auto_renew_local_date: "",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        };
      }
      if (sql.includes("SELECT settings_json FROM settings")) {
        settingsQueries.push(sql);
        return null;
      }
      if (sql.includes("FROM subscriptions")) {
        subscriptionQueries.push(sql);
        return d1All([]);
      }
      throw new Error(`unexpected ${method} query: ${sql}`);
    });

    await expect(renewAutoSubscriptionsForAllUsers(env, new Date("2026-01-09T07:00:00.000Z"))).resolves.toEqual({
      usersProcessed: 0,
      subscriptionsUpdated: 0,
    });

    expect(settingsQueries).toHaveLength(0);
    expect(subscriptionQueries).toHaveLength(0);
  });
});
