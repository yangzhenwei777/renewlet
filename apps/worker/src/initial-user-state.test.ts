import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildInitialUserStateQueries,
  type InitialUserStateQuery,
  type InitialUserStateUser,
} from "./initial-user-state";

describe("initial user state SQLite transaction", () => {
  it("allows exactly one setup contender and leaves no orphan derived rows", () => {
    const contenders = [
      setupUser("usr_first", "first@example.com"),
      setupUser("usr_second", "second@example.com"),
    ];

    for (const ordered of [contenders, [...contenders].reverse()]) {
      const database = migratedDatabase();
      const outcomes = ordered.map((user) => applyQueryPlan(
        database,
        buildInitialUserStateQueries(user, true),
      ));

      expect(outcomes).toEqual([true, false]);
      expect(rowCount(database, "SELECT COUNT(*) AS count FROM users")).toBe(1);
      expect(rowCount(database, "SELECT COUNT(*) AS count FROM settings")).toBe(1);
      expect(rowCount(database, "SELECT COUNT(*) AS count FROM subscription_user_stats")).toBe(1);
      expect(rowCount(database, "SELECT COUNT(*) AS count FROM subscription_scheduler_state")).toBe(1);
      expect(rowCount(database, `
        SELECT COUNT(*) AS count
        FROM settings
        JOIN users ON users.id = settings.user_id
        JOIN subscription_user_stats ON subscription_user_stats.user_id = users.id
        JOIN subscription_scheduler_state ON subscription_scheduler_state.user_id = users.id
      `)).toBe(1);
      expect(textValue(database, "SELECT email AS value FROM users LIMIT 1")).toBe(ordered[0]?.email);
      expect(JSON.parse(textValue(database, "SELECT settings_json AS value FROM settings LIMIT 1"))).toMatchObject({ localePreference: "auto" });
      database.close();
    }
  });
});

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  const migrationsDirectory = new URL("../migrations/", import.meta.url);
  const filenames = readdirSync(migrationsDirectory)
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  for (const filename of filenames) {
    database.exec(readFileSync(new URL(filename, migrationsDirectory), "utf8"));
  }
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function applyQueryPlan(database: DatabaseSync, queries: InitialUserStateQuery[]): boolean {
  database.exec("BEGIN IMMEDIATE");
  try {
    let created = false;
    queries.forEach((query, index) => {
      const result = database.prepare(query.sql).run(...query.bindings);
      if (index === 0) created = result.changes === 1;
    });
    database.exec("COMMIT");
    return created;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function setupUser(id: string, email: string): InitialUserStateUser {
  return {
    id,
    email,
    name: id,
    role: "admin",
    password_hash: "hashed-password",
    created_at: "2026-08-17T00:00:00.000Z",
    updated_at: "2026-08-17T00:00:00.000Z",
  };
}

function rowCount(database: DatabaseSync, sql: string): number {
  const count = database.prepare(sql).get()?.["count"];
  if (typeof count !== "number") throw new Error("SQLite count query did not return a number");
  return count;
}

function textValue(database: DatabaseSync, sql: string): string {
  const value = database.prepare(sql).get()?.["value"];
  if (typeof value !== "string") throw new Error("SQLite text query did not return a string");
  return value;
}
