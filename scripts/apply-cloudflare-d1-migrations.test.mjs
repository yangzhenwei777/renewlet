import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts/apply-cloudflare-d1-migrations.mjs");

function writeFakePnpm(binDir) {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, "pnpm");
  writeFileSync(path, `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const statePath = process.env.FAKE_WRANGLER_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
state.calls ??= [];
const args = process.argv.slice(2);
state.calls.push(args);
const target = "--" + state.target;
const migrationPrefix = ["exec", "wrangler", "d1", "migrations", "apply", "DB", target];
const feedProtectionPrefix = ["exec", "tsx", "scripts/protect-cloudflare-calendar-feeds.ts", target, "--phase"];
const backfillPrefix = ["exec", "tsx", "scripts/backfill-cloudflare-subscription-derived-state.ts", target];
const foreignKeyPrefix = ["exec", "wrangler", "d1", "execute", "DB", target, "--command", "PRAGMA foreign_key_check", "--json"];
const matches = (prefix) => prefix.every((value, index) => args[index] === value);
let response;
if (matches(feedProtectionPrefix)) {
  response = args[5] === "prepare" ? state.feedPrepareResponse : state.feedRestoreResponse;
} else if (matches(migrationPrefix)) {
  response = state.migrationResponses.shift();
} else if (matches(backfillPrefix)) {
  response = state.backfillResponse;
} else if (matches(foreignKeyPrefix)) {
  response = state.foreignKeyResponse;
} else {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.error("unexpected pnpm invocation: " + args.join(" "));
  process.exit(99);
}
writeFileSync(statePath, JSON.stringify(state, null, 2));
if (!response) {
  console.error("missing fake command response");
  process.exit(98);
}
if (response.stdout) process.stdout.write(response.stdout);
if (response.stderr) process.stderr.write(response.stderr);
process.exit(response.status);
`);
  chmodSync(path, 0o755);
}

function runApply(migrationResponses, {
  args = [],
  target = "remote",
  maxAttempts = 5,
  feedPrepareResponse = { status: 0, stdout: "Feed backup complete.\n" },
  feedRestoreResponse = { status: 0, stdout: "Feed restore complete.\n" },
  backfillResponse = { status: 0, stdout: "Backfill complete.\n" },
  foreignKeyResponse = { status: 0, stdout: '[{"success":true,"results":[]}]\n' },
} = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "renewlet-d1-migrations-"));
  const statePath = join(tempDir, "state.json");
  const binDir = join(tempDir, "bin");
  try {
    writeFakePnpm(binDir);
    writeFileSync(statePath, JSON.stringify({
      migrationResponses,
      feedPrepareResponse,
      feedRestoreResponse,
      backfillResponse,
      foreignKeyResponse,
      target,
      calls: [],
    }, null, 2));
    const scriptArgs = target ? [`--${target}`, ...args] : args;
    const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: "super-secret-token",
        FAKE_WRANGLER_STATE: statePath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        RENEWLET_D1_MIGRATION_MAX_ATTEMPTS: String(maxAttempts),
        RENEWLET_D1_MIGRATION_RETRY_BASE_MS: "0",
        RENEWLET_D1_MIGRATION_RETRY_MAX_MS: "0",
      },
    });
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return { result, state };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("passes canonical --config to wrangler and succeeds on the first attempt", () => {
  const { result, state } = runApply([
    { status: 0, stdout: "No migrations to apply.\n" },
  ], { args: ["--config", "wrangler.generated.jsonc"] });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(state.calls, [
    ["exec", "tsx", "scripts/protect-cloudflare-calendar-feeds.ts", "--remote", "--phase", "prepare", "--config", "wrangler.generated.jsonc"],
    ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", "wrangler.generated.jsonc"],
    ["exec", "tsx", "scripts/protect-cloudflare-calendar-feeds.ts", "--remote", "--phase", "restore", "--config", "wrangler.generated.jsonc"],
    ["exec", "tsx", "scripts/backfill-cloudflare-subscription-derived-state.ts", "--remote", "--config", "wrangler.generated.jsonc"],
    ["exec", "wrangler", "d1", "execute", "DB", "--remote", "--command", "PRAGMA foreign_key_check", "--json", "--config", "wrangler.generated.jsonc"],
  ]);
  assert.doesNotMatch(result.stdout + result.stderr, /super-secret-token/);
});

test("runs migration, derived-state backfill, and foreign-key check for local D1", () => {
  const { result, state } = runApply([
    { status: 0, stdout: "No migrations to apply.\n" },
  ], { target: "local", args: ["--config", "wrangler.generated.jsonc"] });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(state.calls, [
    ["exec", "tsx", "scripts/protect-cloudflare-calendar-feeds.ts", "--local", "--phase", "prepare", "--config", "wrangler.generated.jsonc"],
    ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--config", "wrangler.generated.jsonc"],
    ["exec", "tsx", "scripts/protect-cloudflare-calendar-feeds.ts", "--local", "--phase", "restore", "--config", "wrangler.generated.jsonc"],
    ["exec", "tsx", "scripts/backfill-cloudflare-subscription-derived-state.ts", "--local", "--config", "wrangler.generated.jsonc"],
    ["exec", "wrangler", "d1", "execute", "DB", "--local", "--command", "PRAGMA foreign_key_check", "--json", "--config", "wrangler.generated.jsonc"],
  ]);
});

test("prints help without running a D1 command", () => {
  const { result, state } = runApply([], { args: ["--help"] });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: node scripts\/apply-cloudflare-d1-migrations\.mjs/);
  assert.deepEqual(state.calls, []);
});

test("rejects unknown arguments before invoking wrangler", () => {
  const { result, state } = runApply([{ status: 0 }], { args: ["--unknown"] });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown argument: --unknown/);
  assert.deepEqual(state.calls, []);
});

test("requires exactly one explicit local or remote target", () => {
  const missing = runApply([{ status: 0 }], { target: null });
  assert.notEqual(missing.result.status, 0);
  assert.match(missing.result.stderr, /A D1 target is required/);
  assert.deepEqual(missing.state.calls, []);

  const duplicate = runApply([{ status: 0 }], { args: ["--local"] });

  assert.notEqual(duplicate.result.status, 0);
  assert.match(duplicate.result.stderr, /Specify exactly one D1 target/);
  assert.deepEqual(duplicate.state.calls, []);
});

test("does not retry local migration failures", () => {
  const { result, state } = runApply([
    { status: 1, stderr: "D1 DB storage operation exceeded timeout [code: 7429]\n" },
  ], { target: "local" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Local D1 migrations failed/);
  assert.equal(state.calls.length, 2);
});

test("retries Cloudflare D1 timeout code 7429 and then succeeds", () => {
  const { result, state } = runApply([
    { status: 1, stderr: "D1 DB storage operation exceeded timeout which caused object to be reset. [code: 7429]\n" },
    { status: 0, stdout: "Applied 1 migration.\n" },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.calls.length, 6);
  assert.match(result.stderr, /retrying in 0ms \(attempt 2\/5\)/);
});

test("retries documented transient D1 reset errors", () => {
  const { result, state } = runApply([
    { status: 1, stderr: "Network connection lost while querying D1\n" },
    { status: 1, stderr: "storage caused object to be reset\n" },
    { status: 1, stderr: "A request to the Cloudflare API failed. HTTP 500\n" },
    { status: 0, stdout: "Applied migrations.\n" },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.calls.length, 8);
});

test("does not retry authentication, permission, or SQL errors", () => {
  for (const [name, stderr] of [
    ["authentication", "A request to the Cloudflare API failed. Authentication error [code: 10000]\nHTTP 403\n"],
    ["permission", "A request to the Cloudflare API failed. You do not have permission to edit this database.\nHTTP 403\n"],
    ["sql", "near \"CREATEE\": syntax error at offset 0\n"],
  ]) {
    const { result, state } = runApply([{ status: 1, stderr }]);

    assert.notEqual(result.status, 0, name);
    assert.equal(state.calls.length, 2, name);
    assert.match(result.stderr, /non-retryable error/, name);
  }
});

test("fails after retryable errors exceed the configured attempt limit", () => {
  const { result, state } = runApply([
    { status: 1, stderr: "D1 DB storage operation exceeded timeout which caused object to be reset. [code: 7429]\n" },
    { status: 1, stderr: "Network connection lost\n" },
    { status: 1, stderr: "storage caused object to be reset\n" },
  ], { maxAttempts: 3 });

  assert.notEqual(result.status, 0);
  assert.equal(state.calls.length, 4);
  assert.match(result.stderr, /failed after 3 attempts/);
  assert.match(result.stderr, /storage caused object to be reset/);
});

test("blocks migrations when calendar Feed backup fails", () => {
  const { result, state } = runApply(
    [{ status: 0, stdout: "Applied migrations.\n" }],
    { feedPrepareResponse: { status: 1, stderr: "backup invariant failed\n" } },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /calendar Feed backup failed/);
  assert.equal(state.calls.length, 1);
});

test("blocks backfill and deployment when calendar Feed restore fails", () => {
  const { result, state } = runApply(
    [{ status: 0, stdout: "Applied migrations.\n" }],
    { feedRestoreResponse: { status: 1, stderr: "restore invariant failed\n" } },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /calendar Feed restore failed/);
  assert.equal(state.calls.length, 3);
});

test("blocks deployment when derived-state backfill fails", () => {
  const { result, state } = runApply(
    [{ status: 0, stdout: "Applied migrations.\n" }],
    { backfillResponse: { status: 1, stderr: "derived invariant failed\n" } },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /derived-state backfill failed/);
  assert.equal(state.calls.length, 4);
});

test("blocks deployment when foreign-key JSON is invalid or unsuccessful", () => {
  for (const [name, foreignKeyResponse, message] of [
    ["invalid JSON", { status: 0, stdout: "not-json\n" }, /invalid Wrangler JSON/],
    ["unsuccessful result", { status: 0, stdout: '[{"success":false,"results":[]}]\n' }, /unsuccessful Wrangler result/],
    ["missing results", { status: 0, stdout: '[{"success":true}]\n' }, /unsuccessful Wrangler result/],
  ]) {
    const { result, state } = runApply(
      [{ status: 0, stdout: "Applied migrations.\n" }],
      { foreignKeyResponse },
    );

    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, message, name);
    assert.equal(state.calls.length, 5, name);
  }
});

test("blocks deployment when foreign_key_check returns any violation", () => {
  const { result, state } = runApply(
    [{ status: 0, stdout: "Applied migrations.\n" }],
    {
      foreignKeyResponse: {
        status: 0,
        stdout: '[{"success":true,"results":[{"table":"subscriptions","rowid":1}]}]\n',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /foreign key check found violations/);
  assert.equal(state.calls.length, 5);
});
