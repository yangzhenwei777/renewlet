import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "jsonc-parser";
import { unstable_dev } from "wrangler";

test("S3 Cron counts native workerd redirects and checkpoints each remote operation", { timeout: 120_000 }, async (t) => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const config = parse(await readFile(join(root, "wrangler.jsonc"), "utf8"));
  await mkdir(join(root, ".wrangler"), { recursive: true });
  const directory = await mkdtemp(join(root, ".wrangler/backup-transport-"));
  const configPath = join(directory, "wrangler.json");
  await writeFile(configPath, JSON.stringify({
    name: "renewlet-backup-transport-test", compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags, alias: config.alias,
    d1_databases: [{ binding: "DB", database_name: "isolated-backup", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: join(root, "apps/worker/migrations") }],
    r2_buckets: [{ binding: "ASSETS_BUCKET", bucket_name: "isolated-backup" }],
  }));
  let calls = [];
  let scenario = { redirects: 0, status: 307, crossHost: false, sdk: false };
  let objects = new Map();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const hop = calls.length;
    // 只保存凭据是否存在；即使夹具凭据是虚构值，证据也不输出Authorization/Cookie内容。
    calls.push({ method: request.method, path: request.url, host: request.headers.host,
      authorized: Boolean(request.headers.authorization), signed: request.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ") ?? false,
      cookie: Boolean(request.headers.cookie), marker: request.headers["x-fixture"],
      contentType: request.headers["content-type"], contentLanguage: request.headers["content-language"], contentLocation: request.headers["content-location"], contentLength: request.headers["content-length"],
      bodyBytes: bytes.length, bodySha256: createHash("sha256").update(bytes).digest("hex") });
    if (hop < scenario.redirects) {
      let location = request.url;
      if (!scenario.sdk) {
        location = `../next/%2f?literal=a+b&encoded=%2F&duplicate=z&duplicate=a#fragment`;
        if (scenario.crossHost) location = `http://localhost:${server.address().port}/next/%2f?literal=a+b&encoded=%2F&duplicate=z&duplicate=a#fragment`;
      }
      response.writeHead(scenario.status, { location });
      response.end(request.method === "HEAD" ? undefined : "redirect-body");
      return;
    }
    if (!scenario.sdk) { response.writeHead(200, { "content-length": "2" }); response.end("ok"); return; }
    const url = new URL(request.url, "http://127.0.0.1");
    const key = decodeURIComponent(url.pathname.replace(/^\/backup-test\//, ""));
    if (request.method === "PUT") { objects.set(key, bytes); response.writeHead(200); response.end(); return; }
    if (request.method === "DELETE") { objects.delete(key); response.writeHead(204); response.end(); return; }
    if (url.searchParams.has("list-type")) {
      const after = url.searchParams.get("continuation-token");
      const all = [...objects.keys()].filter((key) => !after || key > after).sort();
      const keys = all.slice(0, Number(url.searchParams.get("max-keys")));
      const more = keys.length < all.length;
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>backup-test</Name><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${keys.at(-1)}</NextContinuationToken>` : ""}${keys.map((key) => `<Contents><Key>${key}</Key><Size>${objects.get(key).length}</Size></Contents>`).join("")}</ListBucketResult>`);
      return;
    }
    const object = objects.get(key);
    response.writeHead(object ? 200 : 404, { "content-length": String(object?.length ?? 0) });
    response.end(request.method === "HEAD" ? undefined : object);
  });
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  let worker;
  try {
    const persist = join(directory, "state");
    await promisify(execFile)("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--config", configPath, "--persist-to", persist], { cwd: root, maxBuffer: 2 * 1024 * 1024 });
    worker = await unstable_dev(join(root, "apps/worker/test-fixtures/cloud-backup-transport.ts"), {
      config: configPath, local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0, persist: true, persistTo: persist, envFiles: [], logLevel: "error",
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
    });
    for (const redirects of [0, 1, 10, 20, 21]) {
      await t.test(`matches native fetch with ${redirects} redirects`, async () => {
        scenario = { redirects, status: 307, crossHost: false, sdk: false };
        const samples = [];
        for (const handler of ["native", "counted"]) {
          calls = [];
          const result = await (await worker.fetch(`http://localhost/transport?endpoint=${encodeURIComponent(endpoint + "/start/%2f")}&handler=${handler}`)).json();
          samples.push({ result, calls });
        }
        assert.deepEqual(samples[1].calls, samples[0].calls);
        assert.equal(samples[1].result.resources.externalRequests, samples[1].calls.length);
        assert.equal(samples[1].calls.length, Math.min(redirects + 1, 21));
        assert.equal(Boolean(samples[1].result.error), redirects > 20);
        assert.equal(Boolean(samples[0].result.error), redirects > 20);
      });
    }
    for (const status of [301, 302, 303, 307, 308]) {
      for (const method of ["GET", "HEAD", "POST", "PUT"]) {
        await t.test(`matches native ${method}/${status} across hosts including signed headers and encoded URLs`, async () => {
          scenario = { redirects: 1, status, crossHost: true, sdk: false };
          const samples = [];
          for (const handler of ["native", "counted"]) {
            calls = [];
            const result = await (await worker.fetch(`http://localhost/transport?endpoint=${encodeURIComponent(endpoint + "/start/%2f")}&method=${method}&handler=${handler}`)).json();
            assert.equal(result.status, 200, JSON.stringify(result));
            samples.push(calls);
          }
          assert.deepEqual(samples[1], samples[0]);
          assert.equal(samples[1].length, 2);
          assert.ok(samples[1][0].authorized);
          assert.equal(samples[1][1].authorized, false);
          assert.ok(samples[1].every((call) => call.cookie));
        });
      }
    }
    await t.test("stops before the invocation budget is exceeded", async () => {
      scenario = { redirects: 10, status: 307, crossHost: false, sdk: false };
      calls = [];
      const result = await (await worker.fetch(`http://localhost/transport?endpoint=${encodeURIComponent(endpoint)}&reserved=49`)).json();
      assert.equal(result.error, "CronBudgetExceeded");
      assert.equal(result.resources.externalRequests, 1);
      assert.equal(calls.length, 1);
    });
    for (const redirects of [0, 10, 20]) {
      await t.test(`finishes upload and retention with ${redirects} redirects per operation`, async () => {
        scenario = { redirects, status: 307, crossHost: false, sdk: true };
        objects = new Map();
        for (let index = 0; index < 4; index++) {
          const id = `old-${index}`;
          objects.set(`${id}.zip`, Buffer.from("old zip"));
          objects.set(`${id}.manifest.json`, Buffer.from(JSON.stringify({ kind: "renewlet-cloud-backup-snapshot", schemaVersion: 1,
            id, filename: `${id}.zip`, createdAt: `2026-10-0${index + 1}T00:00:00.000Z`, sizeBytes: 7, sha256: "a".repeat(64), exportKind: "renewlet-export", exportSchemaVersion: 1 })));
        }
        assert.equal((await worker.fetch(`http://localhost/seed?endpoint=${encodeURIComponent(endpoint)}`)).status, 200);
        const ticks = [];
        for (let tick = 0; tick < 50; tick++) {
          calls = [];
          const response = await worker.fetch(`http://localhost/tick?endpoint=${encodeURIComponent(endpoint)}`);
          assert.equal(response.status, 200, await response.clone().text());
          const result = await response.json();
          assert.equal(result.resources.externalRequests, calls.length, JSON.stringify(result));
          assert.ok(result.resources.sql <= 50 && calls.length <= 50);
          assert.notEqual(result.row.last_status, "failed", JSON.stringify(result));
          assert.ok(calls.length === 0 || calls.length === redirects + 1);
          assert.ok(calls.every((call) => call.signed));
          ticks.push({ stage: JSON.parse(result.row.cron_cursor_json).stage ?? "complete", http: calls.length, sql: result.resources.sql, wallMs: result.wallMs });
          if (result.row.last_status === "success") break;
        }
        assert.equal(ticks.at(-1).stage, "complete");
        assert.deepEqual([...objects.keys()].filter((key) => key.startsWith("old-")).sort(), ["old-3.manifest.json", "old-3.zip"]);
        const newManifest = [...objects.keys()].find((key) => !key.startsWith("old-") && key.endsWith(".manifest.json"));
        const manifest = JSON.parse(objects.get(newManifest));
        const zip = objects.get(manifest.filename);
        assert.equal(zip.length, manifest.sizeBytes);
        assert.equal(createHash("sha256").update(zip).digest("hex"), manifest.sha256);
        process.stdout.write(`${JSON.stringify({ environment: "local workerd + D1/R2 + loopback HTTP (not cloud CPU)", redirects, ticks })}\n`);
      });
    }
  } finally {
    await worker?.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
