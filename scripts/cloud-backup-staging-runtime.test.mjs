import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "jsonc-parser";
import { unstable_dev } from "wrangler";

test("backup asset checkpoints survive workerd requests with real local D1/R2", { timeout: 120_000 }, async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const config = parse(await readFile(join(root, "wrangler.jsonc"), "utf8"));
  await mkdir(join(root, ".wrangler"), { recursive: true });
  const directory = await mkdtemp(join(root, ".wrangler/backup-staging-"));
  const configPath = join(directory, "wrangler.json");
  await writeFile(configPath, JSON.stringify({
    name: "renewlet-backup-staging-test", compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags, alias: config.alias,
    d1_databases: [{ binding: "DB", database_name: "isolated-backup", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: join(root, "apps/worker/migrations") }],
    r2_buckets: [{ binding: "ASSETS_BUCKET", bucket_name: "isolated-backup" }],
  }));
  let worker;
  try {
    const persist = join(directory, "state");
    // 使用Wrangler迁移解析器，保留真实trigger/事务语义；D1 exec按行拆分，不用于加载SQL文件。
    const migrateArgs = ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--config", configPath, "--persist-to", persist];
    await promisify(execFile)("pnpm", migrateArgs, { cwd: root, maxBuffer: 2 * 1024 * 1024 });
    const repeated = await promisify(execFile)("pnpm", migrateArgs, { cwd: root, maxBuffer: 2 * 1024 * 1024 });
    assert.match(repeated.stdout, /No migrations to apply/);
    worker = await unstable_dev(join(root, "scripts/fixtures/cloud-backup-staging-runtime.ts"), {
      config: configPath, local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0, persist: true, persistTo: persist, envFiles: [], logLevel: "error",
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
    });
    const seed = await worker.fetch("http://localhost/seed");
    assert.equal(seed.status, 200, await seed.text());
    const baseline = await worker.fetch("http://localhost/expected");
    assert.equal(baseline.status, 200, "baseline ZIP");
    const expected = Buffer.from(await baseline.arrayBuffer());
    const ticks = [];
    for (let tick = 0; tick < 10; tick++) {
      const response = await worker.fetch("http://localhost/tick");
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      ticks.push(result);
      assert.ok(result.resources.sql <= 50);
      assert.ok(result.resources.storageReserved <= 102);
      if (result.result.kind === "complete") break;
    }
    assert.equal(ticks.at(-1).result.kind, "complete");
    assert.equal(ticks.filter((item) => item.result.cursor?.stage === "prepare").length, 2);
    const uploaded = await worker.fetch("http://localhost/actual");
    assert.equal(uploaded.status, 200);
    assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), expected);
    const cleaned = await (await worker.fetch("http://localhost/cleanup")).json();
    assert.deepEqual(cleaned, { records: 0, objects: 0 });
    process.stdout.write(`${JSON.stringify({ environment: "local workerd + D1/R2 (not cloud CPU)", zipBytes: expected.length, sha256: createHash("sha256").update(expected).digest("hex"), ticks })}\n`);
  } finally {
    await worker?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
