import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import { TransactionalD1Database } from "./subscription-d1-test-support";
import type { Env } from "./types";

export const scheduledAt = new Date("2026-09-08T08:00:00Z");
export const settings = { ...createDefaultAppSettings(), timezone: "UTC" };

export function createCronFixture(size: number) {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const env = { DB: new TransactionalD1Database(db) as unknown as D1Database, ASSETS: {} as Fetcher, ASSETS_BUCKET: {} as R2Bucket } satisfies Env;
  const ids = Array.from({ length: size }, (_, index) => `usr-${String(index).padStart(4, "0")}`);
  const insert = db.prepare("INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at) VALUES (?, ?, 'Cron', 'user', '', '', '')");
  for (const id of ids) {
    insert.run(id, `${id}@example.test`);
    db.prepare("INSERT INTO settings (user_id, settings_json, created_at, updated_at) VALUES (?, ?, '', '')").run(id, JSON.stringify(settings));
    db.prepare("INSERT INTO subscription_scheduler_state (user_id, next_daily_notification_due_at_utc, created_at, updated_at) VALUES (?, ?, '', '')").run(id, scheduledAt.toISOString());
    db.prepare("INSERT INTO subscription_user_stats (user_id, created_at, updated_at) VALUES (?, '', '')").run(id);
  }
  return { db, env, ids };
}

