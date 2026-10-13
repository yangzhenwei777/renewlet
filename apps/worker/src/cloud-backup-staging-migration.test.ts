import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const directory = new URL("../migrations/", import.meta.url);
const migration = "0046_exclusive_cloud_backup_staging.sql";
function apply(db: DatabaseSync, name: string) {
  if (db.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").get(name)) return;
  db.exec("BEGIN");
  try {
    db.exec(readFileSync(new URL(name, directory), "utf8"));
    db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

describe("cloud backup staging migration", () => {
  it("preserves old data and snapshot identity, rolls back a failed migration and keeps progress on restart", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE d1_migrations (name TEXT PRIMARY KEY)");
      for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql") && name < migration).sort()) apply(db, name);
      db.exec("INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at) VALUES ('owner', 'owner@example.test', 'Owner', 'user', '', '', '')");
      const insert = db.prepare(`INSERT INTO cloud_backup_targets (user_id, provider, config_json, credential_json, cron_cursor_json, created_at, updated_at)
        VALUES ('owner', ?, '{"existing":true}', '{"fixture":"secret"}', ?, '', '')`);
      const upload = { stage: "upload", id: "existing", createdAt: "2026-10-09T00:00:00.000Z" };
      const scan = { stage: "scan", id: "existing", createdAt: upload.createdAt, after: "page", retained: [] };
      insert.run("s3", JSON.stringify(upload)); insert.run("webdav", JSON.stringify(scan));
      const original = db.prepare("SELECT * FROM cloud_backup_targets ORDER BY provider").all();
      db.exec(`CREATE TRIGGER fail_marker BEFORE INSERT ON d1_migrations WHEN NEW.name = '${migration}' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
      expect(() => apply(db, migration)).toThrow("fixture failure");
      expect(db.prepare("SELECT * FROM cloud_backup_targets ORDER BY provider").all()).toEqual(original);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'cloud_backup_staging'").get()).toBeUndefined();
      db.exec("DROP TRIGGER fail_marker");
      apply(db, migration);
      const rows = db.prepare("SELECT * FROM cloud_backup_targets ORDER BY provider").all();
      expect(rows).toEqual(original.map((row) => row["provider"] === "s3" ? { ...row, cron_cursor_json: JSON.stringify({ ...upload, stage: "prepare", stagingKey: null }) } : row));
      db.exec("UPDATE cloud_backup_targets SET cron_cursor_json = json_set(cron_cursor_json, '$.stagingKey', 'in-progress') WHERE provider = 's3'");
      apply(db, migration);
      expect(db.prepare("SELECT json_extract(cron_cursor_json, '$.stagingKey') AS key FROM cloud_backup_targets WHERE provider = 's3'").get()?.["key"]).toBe("in-progress");
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT r2_key FROM cloud_backup_staging WHERE created_at <= ? AND NOT EXISTS
        (SELECT 1 FROM cloud_backup_targets WHERE CAST(json_extract(cron_cursor_json, '$.stagingKey') AS TEXT) = r2_key)
        ORDER BY created_at, r2_key LIMIT ?`).all("now", 4);
      expect(plan.some((row) => String(row["detail"]).includes("idx_cloud_backup_staging_age"))).toBe(true);
      expect(plan.some((row) => String(row["detail"]).includes("idx_cloud_backup_staging_reference"))).toBe(true);
      expect(plan.some((row) => /SCAN cloud_backup_targets|TEMP B-TREE/.test(String(row["detail"])))).toBe(false);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA quick_check").get()?.["quick_check"]).toBe("ok");
    } finally { db.close(); }
  });
});
