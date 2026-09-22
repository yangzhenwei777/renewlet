import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkCloudflareMigrationSafety } from "./check-cloudflare-migration-safety.mjs";

function withMigrations(files, run) {
  const root = mkdtempSync(join(tmpdir(), "renewlet-d1-migration-safety-"));
  const migrations = join(root, "apps/worker/migrations");
  mkdirSync(migrations, { recursive: true });
  try {
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(migrations, name), sql);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("allows the historical 0035 rebuild and safe later migrations", () => {
  withMigrations({
    "0035_historical.sql": "PRAGMA foreign_keys = OFF;\nDROP TABLE subscriptions;\n",
    "0039_safe.sql": "DELETE FROM subscription_list_index;\n",
  }, (root) => assert.doesNotThrow(() => checkCloudflareMigrationSafety(root)));
});

test("rejects future attempts to disable D1 foreign keys", () => {
  for (const [name, sql] of [
    ["quoted", "PRAGMA \"main\".[foreign_keys](NO);"],
    ["string value", "PRAGMA foreign_keys='OFF';"],
    ["parenthesized zero", "PRAGMA foreign_keys = (+00);"],
  ]) {
    withMigrations({
      "0040_unsafe.sql": sql,
    }, (root) => assert.throws(
      () => checkCloudflareMigrationSafety(root),
      /must not disable D1 foreign keys/,
      name,
    ));
  }
});

test("rejects future direct subscriptions table drops but ignores comments and string contents", () => {
  withMigrations({
    "0040_comment.sql": [
      "-- DROP TABLE subscriptions;",
      "SELECT 'DROP TABLE subscriptions';",
      "SELECT 'PRAGMA foreign_keys=OFF';",
      "SELECT 'PRAGMA' AS foreign_keys, 'OFF';",
      "/* DROP TABLE subscriptions; */",
    ].join("\n"),
  }, (root) => assert.doesNotThrow(() => checkCloudflareMigrationSafety(root)));
  withMigrations({
    "0041_unsafe.sql": "SELECT '--'; DROP TABLE IF EXISTS `main`.\"subscriptions\";\n",
  }, (root) => assert.throws(() => checkCloudflareMigrationSafety(root), /must not drop subscriptions directly/));
  withMigrations({
    "0042_unsafe.sql": "DROP TABLE 'subscriptions';\n",
  }, (root) => assert.throws(() => checkCloudflareMigrationSafety(root), /must not drop subscriptions directly/));
});

test("rejects future direct subscription fact deletion", () => {
  withMigrations({
    "0040_unsafe.sql": "DELETE FROM [main].`subscriptions` WHERE status = 'expired';\n",
  }, (root) => assert.throws(() => checkCloudflareMigrationSafety(root), /must not delete from subscriptions directly/));
});
