import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CALENDAR_FEED_0035_BACKUP_TABLE,
  prepareCalendarFeedsFor0035,
  restoreCalendarFeedsAfter0035,
} from "./cloudflare-calendar-feed-upgrade";
import type {
  D1Client,
  D1QueryResult,
  D1RowParser,
  D1Statement,
  D1Value,
} from "./cloudflare-d1-client";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const timestamp = "2026-08-24T00:00:00.000Z";
const userId = "usr_feed_upgrade";
const subscriptionId = "sub_feed_upgrade";

function plainRows(rows: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => ({ ...row }));
}

function plainRow(row: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return row === undefined ? undefined : { ...row };
}

class SqliteOperationsClient implements D1Client {
  constructor(readonly db: DatabaseSync) {}

  async query<T>(sql: string, params: readonly D1Value[], parseRow: D1RowParser<T>): Promise<T[]> {
    return this.db.prepare(sql).all(...[...params] as SQLInputValue[]).map(parseRow);
  }

  async batch(statements: readonly D1Statement[]): Promise<D1QueryResult[]> {
    if (statements.length === 0) return [];
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement): D1QueryResult => {
        this.db.prepare(statement.sql).run(...[...(statement.params ?? [])] as SQLInputValue[]);
        return { success: true, results: [] };
      });
      this.db.exec("COMMIT");
      return results;
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

// D1 可能已经提交 batch，但调用方丢失响应；该适配器验证恢复流程不会提前删除备份，且整批可重放。
class FailAfterFirstBatchClient implements D1Client {
  private failed = false;

  constructor(private readonly delegate: D1Client) {}

  query<T>(sql: string, params: readonly D1Value[], parseRow: D1RowParser<T>): Promise<T[]> {
    return this.delegate.query(sql, params, parseRow);
  }

  async batch(statements: readonly D1Statement[]): Promise<D1QueryResult[]> {
    const results = await this.delegate.batch(statements);
    if (!this.failed && statements.length > 0) {
      this.failed = true;
      throw new Error("injected response loss after committed Feed restore");
    }
    return results;
  }
}

// 保留 0035 前真实 Feed 外键和 partial index，确保夹具能观察 subscription 重建造成的级联删除。
function openPre0035Database(): SqliteOperationsClient {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE d1_migrations (name TEXT PRIMARY KEY);
    INSERT INTO d1_migrations (name) VALUES ('0005_calendar_feeds.sql');
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      logo TEXT,
      price TEXT NOT NULL,
      currency TEXT NOT NULL,
      billing_cycle TEXT NOT NULL,
      custom_days INTEGER,
      custom_cycle_unit TEXT,
      one_time_term_count INTEGER,
      one_time_term_unit TEXT,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      public_hidden INTEGER NOT NULL DEFAULT 0,
      payment_method TEXT,
      start_date TEXT,
      next_billing_date TEXT NOT NULL,
      auto_renew INTEGER NOT NULL DEFAULT 0,
      auto_calculate_next_billing_date INTEGER NOT NULL,
      trial_end_date TEXT,
      website TEXT,
      notes TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      reminder_days INTEGER NOT NULL,
      repeat_reminder_enabled INTEGER NOT NULL,
      repeat_reminder_interval TEXT NOT NULL,
      repeat_reminder_window TEXT NOT NULL,
      cost_sharing_json TEXT NOT NULL DEFAULT '{}',
      extra_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE calendar_feeds (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('all', 'subscription')),
      subscription_id TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE CHECK (length(token) = 43),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (scope = 'all' AND subscription_id IS NULL)
        OR (scope = 'subscription' AND subscription_id IS NOT NULL)
      )
    );
    CREATE UNIQUE INDEX idx_calendar_feeds_user_all_unique
      ON calendar_feeds (user_id) WHERE scope = 'all';
    CREATE UNIQUE INDEX idx_calendar_feeds_token ON calendar_feeds (token);
    CREATE UNIQUE INDEX idx_calendar_feeds_user_subscription_unique
      ON calendar_feeds (user_id, subscription_id) WHERE scope = 'subscription';
    INSERT INTO users (id) VALUES ('${userId}');
    INSERT INTO subscriptions (
      id, user_id, name, price, currency, billing_cycle, category, status,
      next_billing_date, auto_calculate_next_billing_date, tags_json, reminder_days,
      repeat_reminder_enabled, repeat_reminder_interval, repeat_reminder_window,
      cost_sharing_json, extra_json, created_at, updated_at
    ) VALUES (
      '${subscriptionId}', '${userId}', 'Renewlet', '12.00', 'USD', 'monthly', 'software', 'active',
      '2026-09-24', 1, '["工具"]', 3, 1, 'daily', 'before', '{}', '{}', '${timestamp}', '${timestamp}'
    );
    INSERT INTO calendar_feeds (id, user_id, scope, subscription_id, token, created_at, updated_at)
    VALUES
      ('feed_all', '${userId}', 'all', NULL, '${"a".repeat(43)}', '${timestamp}', '${timestamp}'),
      ('feed_subscription', '${userId}', 'subscription', '${subscriptionId}', '${"s".repeat(43)}', '${timestamp}', '${timestamp}');
  `);
  return new SqliteOperationsClient(db);
}

function apply0035WithD1ForeignKeys(client: SqliteOperationsClient): void {
  const migration = readFileSync(
    resolve(repoRoot, "apps/worker/migrations/0035_rebuild_cost_sharing_collection_reminder_schema.sql"),
    "utf8",
  ).replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*(?:OFF|ON)\s*;\s*$/gim, "");
  // D1 不允许 migration 关闭外键；剥掉 PRAGMA 后执行真实 DROP，才能复现 subscription Feed 的级联删除。
  client.db.exec(migration);
  client.db.prepare("INSERT INTO d1_migrations (name) VALUES (?)")
    .run("0035_rebuild_cost_sharing_collection_reminder_schema.sql");
}

function feedRows(db: DatabaseSync): unknown[] {
  return plainRows(db.prepare(`SELECT id, user_id, scope, subscription_id, token, created_at, updated_at
    FROM calendar_feeds ORDER BY id`).all());
}

test("upgrades the v0.2.97 Feed path across D1 migration 0035 without changing URLs", async () => {
  const client = openPre0035Database();
  try {
    const expected = feedRows(client.db);
    assert.deepEqual(await prepareCalendarFeedsFor0035(client), { action: "backed-up", feeds: 2 });
    assert.deepEqual(await prepareCalendarFeedsFor0035(client), { action: "backed-up", feeds: 2 });

    apply0035WithD1ForeignKeys(client);
    assert.deepEqual(plainRows(client.db.prepare("SELECT id FROM calendar_feeds ORDER BY id").all()), [{ id: "feed_all" }]);

    assert.deepEqual(await restoreCalendarFeedsAfter0035(client), { action: "restored", feeds: 2 });
    assert.deepEqual(feedRows(client.db), expected);
    assert.equal(client.db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = ?`).get(CALENDAR_FEED_0035_BACKUP_TABLE)?.["count"], 0);
    assert.deepEqual(await restoreCalendarFeedsAfter0035(client), { action: "skipped", feeds: 0 });
    assert.deepEqual(client.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    client.db.close();
  }
});

test("replays a committed Feed restore after its response is lost", async () => {
  const client = openPre0035Database();
  try {
    const expected = feedRows(client.db);
    await prepareCalendarFeedsFor0035(client);
    apply0035WithD1ForeignKeys(client);

    await assert.rejects(
      restoreCalendarFeedsAfter0035(new FailAfterFirstBatchClient(client)),
      /injected response loss/,
    );
    assert.equal(client.db.prepare(`SELECT COUNT(*) AS count FROM ${CALENDAR_FEED_0035_BACKUP_TABLE}`)
      .get()?.["count"], 2);
    assert.deepEqual(await restoreCalendarFeedsAfter0035(client), { action: "restored", feeds: 2 });
    assert.deepEqual(feedRows(client.db), expected);
  } finally {
    client.db.close();
  }
});

test("mirrors Feed changes made by the old Worker between prepare and migration", async () => {
  const client = openPre0035Database();
  try {
    await prepareCalendarFeedsFor0035(client);
    const updatedToken = "u".repeat(43);
    client.db.prepare("UPDATE calendar_feeds SET token = ?, updated_at = ? WHERE id = 'feed_subscription'")
      .run(updatedToken, "2026-08-24T01:00:00.000Z");

    apply0035WithD1ForeignKeys(client);
    await restoreCalendarFeedsAfter0035(client);

    assert.deepEqual(plainRow(client.db.prepare(`SELECT token, updated_at FROM calendar_feeds
      WHERE id = 'feed_subscription'`).get()), {
      token: updatedToken,
      updated_at: "2026-08-24T01:00:00.000Z",
    });
  } finally {
    client.db.close();
  }
});

test("keeps a newly generated Feed instead of restoring its superseded pre-migration URL", async () => {
  const client = openPre0035Database();
  try {
    await prepareCalendarFeedsFor0035(client);
    apply0035WithD1ForeignKeys(client);
    client.db.prepare(`INSERT INTO calendar_feeds
      (id, user_id, scope, subscription_id, token, created_at, updated_at)
      VALUES (?, ?, 'subscription', ?, ?, ?, ?)`)
      .run("feed_subscription_new", userId, subscriptionId, "n".repeat(43), timestamp, timestamp);

    assert.deepEqual(await restoreCalendarFeedsAfter0035(client), { action: "restored", feeds: 2 });
    assert.deepEqual(plainRows(client.db.prepare(`SELECT id, token FROM calendar_feeds
      WHERE scope = 'subscription'`).all()), [{
      id: "feed_subscription_new",
      token: "n".repeat(43),
    }]);
  } finally {
    client.db.close();
  }
});

test("rebuilds missing mirror triggers and reconciles current Feeds after an interrupted cleanup", async () => {
  const client = openPre0035Database();
  try {
    await prepareCalendarFeedsFor0035(client);
    apply0035WithD1ForeignKeys(client);
    client.db.exec(`
      DROP TRIGGER renewlet_calendar_feeds_0035_insert;
      DROP TRIGGER renewlet_calendar_feeds_0035_update;
      DROP TRIGGER renewlet_calendar_feeds_0035_delete;
    `);
    client.db.prepare(`INSERT INTO calendar_feeds
      (id, user_id, scope, subscription_id, token, created_at, updated_at)
      VALUES (?, ?, 'subscription', ?, ?, ?, ?)`)
      .run("feed_subscription_new", userId, subscriptionId, "n".repeat(43), timestamp, timestamp);

    assert.deepEqual(await prepareCalendarFeedsFor0035(client), { action: "skipped", feeds: 2 });
    assert.deepEqual(await restoreCalendarFeedsAfter0035(client), { action: "restored", feeds: 2 });
    assert.deepEqual(plainRows(client.db.prepare(`SELECT id, token FROM calendar_feeds
      WHERE scope = 'subscription'`).all()), [{
      id: "feed_subscription_new",
      token: "n".repeat(43),
    }]);
  } finally {
    client.db.close();
  }
});

test("does not resurrect a Feed explicitly revoked after prepare", async () => {
  const client = openPre0035Database();
  try {
    await prepareCalendarFeedsFor0035(client);
    client.db.prepare("DELETE FROM calendar_feeds WHERE id = 'feed_subscription'").run();

    apply0035WithD1ForeignKeys(client);
    assert.deepEqual(await restoreCalendarFeedsAfter0035(client), { action: "restored", feeds: 1 });
    assert.deepEqual(plainRows(client.db.prepare("SELECT id FROM calendar_feeds ORDER BY id").all()), [{ id: "feed_all" }]);
  } finally {
    client.db.close();
  }
});

test("skips fresh and already-upgraded databases without fabricating Feed tokens", async () => {
  const fresh = new SqliteOperationsClient(new DatabaseSync(":memory:"));
  try {
    assert.deepEqual(await prepareCalendarFeedsFor0035(fresh), { action: "skipped", feeds: 0 });
  } finally {
    fresh.db.close();
  }

  const upgraded = openPre0035Database();
  try {
    apply0035WithD1ForeignKeys(upgraded);
    assert.deepEqual(await prepareCalendarFeedsFor0035(upgraded), { action: "skipped", feeds: 0 });
    assert.deepEqual(await restoreCalendarFeedsAfter0035(upgraded), { action: "skipped", feeds: 0 });
    assert.deepEqual(plainRows(upgraded.db.prepare("SELECT id FROM calendar_feeds ORDER BY id").all()), [{ id: "feed_all" }]);
  } finally {
    upgraded.db.close();
  }
});

test("does not resurrect a subscription Feed revoked after migration 0035", async () => {
  const client = openPre0035Database();
  try {
    await prepareCalendarFeedsFor0035(client);
    apply0035WithD1ForeignKeys(client);
    client.db.prepare("DELETE FROM subscriptions WHERE id = ?").run(subscriptionId);

    assert.deepEqual(await prepareCalendarFeedsFor0035(client), { action: "skipped", feeds: 1 });
    assert.deepEqual(await restoreCalendarFeedsAfter0035(client), { action: "restored", feeds: 1 });
    assert.deepEqual(plainRows(client.db.prepare("SELECT id FROM calendar_feeds ORDER BY id").all()), [{ id: "feed_all" }]);
  } finally {
    client.db.close();
  }
});

test("preserves a mismatched-owner backup as a mixed-state blocker", async () => {
  const client = openPre0035Database();
  try {
    await prepareCalendarFeedsFor0035(client);
    apply0035WithD1ForeignKeys(client);
    client.db.exec("INSERT INTO users (id) VALUES ('usr_other')");
    client.db.prepare("UPDATE subscriptions SET user_id = 'usr_other' WHERE id = ?").run(subscriptionId);

    await assert.rejects(
      restoreCalendarFeedsAfter0035(client),
      /backup no longer matches subscription facts/,
    );
    assert.equal(client.db.prepare(`SELECT COUNT(*) AS count FROM ${CALENDAR_FEED_0035_BACKUP_TABLE}`)
      .get()?.["count"], 2);
  } finally {
    client.db.close();
  }
});

test("blocks a calendar Feed table whose scope and token constraints were removed", async () => {
  const client = openPre0035Database();
  try {
    client.db.exec(`
      ALTER TABLE calendar_feeds RENAME TO calendar_feeds_old;
      CREATE TABLE calendar_feeds (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        subscription_id TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO calendar_feeds SELECT * FROM calendar_feeds_old;
      DROP TABLE calendar_feeds_old;
      CREATE UNIQUE INDEX idx_calendar_feeds_user_all_unique
        ON calendar_feeds (user_id) WHERE scope = 'all';
      CREATE UNIQUE INDEX idx_calendar_feeds_token ON calendar_feeds (token);
      CREATE UNIQUE INDEX idx_calendar_feeds_user_subscription_unique
        ON calendar_feeds (user_id, subscription_id) WHERE scope = 'subscription';
    `);

    await assert.rejects(
      prepareCalendarFeedsFor0035(client),
      /calendar Feed constraints are invalid or mixed/,
    );
  } finally {
    client.db.close();
  }
});

test("blocks a calendar Feed partial index with a weakened scope predicate", async () => {
  const client = openPre0035Database();
  try {
    client.db.exec(`
      DROP INDEX idx_calendar_feeds_user_all_unique;
      CREATE UNIQUE INDEX idx_calendar_feeds_user_all_unique
        ON calendar_feeds (user_id) WHERE scope = 'all' OR user_id = 'usr_not_present';
    `);

    await assert.rejects(
      prepareCalendarFeedsFor0035(client),
      /calendar Feed indexes are invalid or mixed/,
    );
  } finally {
    client.db.close();
  }
});

test("blocks a partially rebuilt subscriptions table and preserves the original schema", async () => {
  const client = openPre0035Database();
  try {
    client.db.exec("CREATE TABLE subscriptions_0035_new (id TEXT PRIMARY KEY)");

    await assert.rejects(
      prepareCalendarFeedsFor0035(client),
      /partial temporary table/,
    );
    assert.equal(client.db.prepare("SELECT COUNT(*) AS count FROM subscriptions").get()?.["count"], 1);
  } finally {
    client.db.close();
  }
});

test("blocks an unrecorded mixed post-0035 subscriptions schema", async () => {
  const client = openPre0035Database();
  try {
    const migration = readFileSync(
      resolve(repoRoot, "apps/worker/migrations/0035_rebuild_cost_sharing_collection_reminder_schema.sql"),
      "utf8",
    ).replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*(?:OFF|ON)\s*;\s*$/gim, "");
    client.db.exec(migration);

    await assert.rejects(
      prepareCalendarFeedsFor0035(client),
      /0035 shape without its migration record/,
    );
  } finally {
    client.db.close();
  }
});
