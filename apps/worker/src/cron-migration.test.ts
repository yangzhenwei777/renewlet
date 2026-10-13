import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migration = "0045_exclusive_cron_progress.sql";
const directory = new URL("../migrations/", import.meta.url);
function apply(db: DatabaseSync, name: string) {
  if (db.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").get(name)) return;
  db.exec("BEGIN");
  try {
    db.exec(readFileSync(new URL(name, directory), "utf8"));
    db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

describe("Cron progress migration", () => {
  it("preserves existing targets, rolls back a failed ledger commit and skips an applied migration on restart", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE d1_migrations (name TEXT PRIMARY KEY)");
      for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql") && name < migration).sort()) apply(db, name);
      db.exec(`INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at) VALUES ('owner', 'owner@example.test', 'Owner', 'user', '', '', '');
        INSERT INTO cloud_backup_targets (user_id, provider, config_json, credential_json, last_backup_at, created_at, updated_at)
        VALUES ('owner', 's3', '{"s3":{"bucket":"existing"}}', '{"s3SecretAccessKey":"fixture"}', '2026-09-07T00:00:00Z', '', '');`);
      const before = db.prepare("SELECT * FROM cloud_backup_targets").get();
      db.exec(`CREATE TRIGGER fail_migration_marker BEFORE INSERT ON d1_migrations WHEN NEW.name = '${migration}'
        BEGIN SELECT RAISE(ABORT, 'fixture marker failure'); END;`);
      expect(() => apply(db, migration)).toThrow("fixture marker failure");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'cron_progress'").get()).toBeUndefined();
      expect(db.prepare("SELECT * FROM cloud_backup_targets").get()).toEqual(before);
      db.exec("DROP TRIGGER fail_migration_marker");
      apply(db, migration);
      expect(db.prepare("SELECT * FROM cloud_backup_targets").get()).toEqual({ ...before, cron_cursor_json: "{}", cron_claim_token: null });
      db.exec(`INSERT INTO cron_progress (user_id, phase, scheduled_at_utc, time_zone, notification_time_local, subscription_after_id)
        VALUES ('owner', 'renewal', '2026-09-08T08:00:00Z', 'UTC', '08:00', 'sub-0049')`);
      apply(db, migration);
      expect(db.prepare("SELECT subscription_after_id FROM cron_progress").get()?.["subscription_after_id"]).toBe("sub-0049");
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA quick_check").get()?.["quick_check"]).toBe("ok");
    } finally { db.close(); }
  });
});
