import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts/ensure-cloudflare-queues.ts");

function writeQueueConfig(path, { queue = "renewlet-test-refresh", dlq = "renewlet-test-refresh-dlq", includeConsumer = true } = {}) {
  writeFileSync(path, `${JSON.stringify({
    queues: {
      producers: [{ binding: "MEDIA_ICON_INDEX_REFRESH_QUEUE", queue }],
      consumers: includeConsumer ? [{ queue, dead_letter_queue: dlq }] : [],
    },
  }, null, 2)}\n`);
}

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
const [exec, wrangler, queues, command, name] = args;
if (exec !== "exec" || wrangler !== "wrangler" || queues !== "queues" || !command || !name) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.error("unexpected pnpm invocation: " + args.join(" "));
  process.exit(99);
}
const index = state.responses.findIndex((item) => item.command === command && item.name === name);
if (index < 0) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.error("missing fake response for " + command + " " + name);
  process.exit(98);
}
const [response] = state.responses.splice(index, 1);
writeFileSync(statePath, JSON.stringify(state, null, 2));
if (response.stdout) process.stdout.write(response.stdout);
if (response.stderr) process.stderr.write(response.stderr);
process.exit(response.status);
`);
  chmodSync(path, 0o755);
  return path;
}

function runEnsure(responses, configOptions) {
  const tempDir = mkdtempSync(join(tmpdir(), "renewlet-queues-ensure-"));
  const configPath = join(tempDir, "wrangler.generated.jsonc");
  const statePath = join(tempDir, "state.json");
  const binDir = join(tempDir, "bin");
  try {
    writeQueueConfig(configPath, configOptions);
    writeFakePnpm(binDir);
    writeFileSync(statePath, JSON.stringify({ responses, calls: [] }, null, 2));
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CI_WRANGLER_CONFIG: configPath,
        FAKE_WRANGLER_STATE: statePath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return { result, state };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const missingQueue = (name) => ({
  command: "info",
  name,
  status: 1,
  stderr: `Queue "${name}" does not exist. To create it, run: wrangler queues create ${name}\n`,
});

test("skips create when producer queue and DLQ already exist", () => {
  const { result, state } = runEnsure([
    { command: "info", name: "renewlet-test-refresh", status: 0, stdout: "Queue Name: renewlet-test-refresh\n" },
    { command: "info", name: "renewlet-test-refresh-dlq", status: 0, stdout: "Queue Name: renewlet-test-refresh-dlq\n" },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Cloudflare Queue ready: renewlet-test-refresh/);
  assert.match(result.stdout, /Cloudflare Queue ready: renewlet-test-refresh-dlq/);
  assert.deepEqual(state.calls.map((args) => [args[3], args[4]]), [
    ["info", "renewlet-test-refresh"],
    ["info", "renewlet-test-refresh-dlq"],
  ]);
});

test("creates missing queues from producer and dead-letter bindings", () => {
  const { result, state } = runEnsure([
    missingQueue("renewlet-test-refresh"),
    { command: "create", name: "renewlet-test-refresh", status: 0, stdout: "Created queue\n" },
    missingQueue("renewlet-test-refresh-dlq"),
    { command: "create", name: "renewlet-test-refresh-dlq", status: 0, stdout: "Created queue\n" },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(state.calls.map((args) => [args[3], args[4]]), [
    ["info", "renewlet-test-refresh"],
    ["create", "renewlet-test-refresh"],
    ["info", "renewlet-test-refresh-dlq"],
    ["create", "renewlet-test-refresh-dlq"],
  ]);
});

test("confirms queue existence after Cloudflare 11009 already taken create conflict", () => {
  const { result, state } = runEnsure([
    missingQueue("renewlet-test-refresh"),
    {
      command: "create",
      name: "renewlet-test-refresh",
      status: 1,
      stderr: "Queue name 'renewlet-test-refresh' is already taken. Please use a different name and try again. [code: 11009]\n",
    },
    { command: "info", name: "renewlet-test-refresh", status: 0, stdout: "Queue Name: renewlet-test-refresh\n" },
  ], { includeConsumer: false });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(state.calls.map((args) => [args[3], args[4]]), [
    ["info", "renewlet-test-refresh"],
    ["create", "renewlet-test-refresh"],
    ["info", "renewlet-test-refresh"],
  ]);
});

test("does not swallow permission or account errors from create", () => {
  const { result } = runEnsure([
    missingQueue("renewlet-test-refresh"),
    {
      command: "create",
      name: "renewlet-test-refresh",
      status: 1,
      stderr: "A request to the Cloudflare API failed. Authentication error [code: 10000]\nHTTP 403\n",
    },
  ], { includeConsumer: false });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Failed to create Cloudflare Queue renewlet-test-refresh/);
  assert.match(result.stderr, /HTTP 403/);
});

test("does not swallow create conflict when the queue cannot be confirmed afterwards", () => {
  const { result } = runEnsure([
    missingQueue("renewlet-test-refresh"),
    {
      command: "create",
      name: "renewlet-test-refresh",
      status: 1,
      stderr: "Queue name 'renewlet-test-refresh' is already taken. [code: 11009]\n",
    },
    {
      command: "info",
      name: "renewlet-test-refresh",
      status: 1,
      stderr: "A request to the Cloudflare API failed. Authentication error [code: 10000]\nHTTP 403\n",
    },
  ], { includeConsumer: false });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /create conflicted but the queue could not be confirmed/);
  assert.match(result.stderr, /11009/);
  assert.match(result.stderr, /HTTP 403/);
});
