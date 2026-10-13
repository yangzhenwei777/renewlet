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

test("notification Cron counts workerd redirects and resumes each channel from D1", { timeout: 120_000 }, async (t) => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const config = parse(await readFile(join(root, "wrangler.jsonc"), "utf8"));
  await mkdir(join(root, ".wrangler"), { recursive: true });
  const directory = await mkdtemp(join(root, ".wrangler/notification-transport-"));
  const configPath = join(directory, "wrangler.json");
  await writeFile(configPath, JSON.stringify({ name: "renewlet-notification-transport-test", compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags,
    d1_databases: [{ binding: "DB", database_name: "isolated-notification", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: join(root, "apps/worker/migrations") }],
  }));
  let calls = [];
  let scenario = { redirects: 0, status: 307, crossHost: false };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    calls.push({ method: request.method, path: request.url, authorized: Boolean(request.headers.authorization), cookie: Boolean(request.headers.cookie),
      contentType: request.headers["content-type"], contentLanguage: request.headers["content-language"], contentLocation: request.headers["content-location"],
      contentLength: request.headers["content-length"], bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
    const current = new URL(request.url, "http://fixture");
    const hop = Number(current.searchParams.get("hop") ?? 0);
    if (hop < scenario.redirects) {
      const path = `/next/%2f?hop=${hop + 1}&literal=a+b&encoded=%2F&duplicate=z&duplicate=a#fragment`;
      response.writeHead(scenario.status, { location: scenario.crossHost ? `http://localhost:${server.address().port}${path}` : path });
      response.end(request.method === "HEAD" ? undefined : "redirect-body"); return;
    }
    response.writeHead(200, { "content-length": "2" }); response.end(request.method === "HEAD" ? undefined : "ok");
  });
  server.listen(0, "0.0.0.0"); await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}/start/%2f`;
  const persist = join(directory, "state");
  const start = () => unstable_dev(join(root, "apps/worker/test-fixtures/notification-transport.ts"), {
    config: configPath, local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0, persist: true, persistTo: persist, envFiles: [], logLevel: "error",
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
  });
  let worker;
  try {
    await promisify(execFile)("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--config", configPath, "--persist-to", persist], { cwd: root, maxBuffer: 2 * 1024 * 1024 });
    worker = await start();
    const invoke = async (path) => {
      const response = await worker.fetch(`http://localhost${path}${path.includes("?") ? "&" : "?"}endpoint=${encodeURIComponent(endpoint)}`);
      assert.equal(response.status, 200, await response.clone().text()); return await response.json();
    };
    for (const redirects of [0, 1, 10, 20, 21]) {
      await t.test(`matches native workerd with ${redirects} redirects`, async () => {
        scenario = { redirects, status: 307, crossHost: false };
        const samples = [];
        for (const handler of ["native", "counted"]) { calls = []; samples.push({ result: await invoke(`/transport?handler=${handler}`), calls }); }
        assert.deepEqual(samples[1].calls, samples[0].calls);
        assert.equal(samples[1].result.resources.externalRequests, samples[1].calls.length);
        assert.equal(samples[1].calls.length, Math.min(redirects + 1, 21));
        assert.equal(Boolean(samples[0].result.error), redirects > 20); assert.equal(Boolean(samples[1].result.error), redirects > 20);
      });
    }
    for (const status of [301, 302, 303, 307, 308]) for (const method of ["GET", "HEAD", "POST", "PUT"]) {
      await t.test(`matches native ${method}/${status}, cross-origin credentials, body and encoded query`, async () => {
        scenario = { redirects: 1, status, crossHost: true };
        const samples = [];
        for (const handler of ["native", "counted"]) {
          calls = []; assert.equal((await invoke(`/transport?handler=${handler}&method=${method}`)).status, 200); samples.push(calls);
        }
        assert.deepEqual(samples[1], samples[0]); assert.equal(samples[1].length, 2);
        assert.ok(samples[1][0].authorized); assert.equal(samples[1][1].authorized, false); assert.ok(samples[1].every((call) => call.cookie));
      });
    }
    for (const status of [301, 302, 303, 307, 308]) {
      await t.test(`preserves Fetch-generated Content-Type across POST/${status}`, async () => {
        scenario = { redirects: 1, status, crossHost: true };
        const samples = [];
        for (const handler of ["native", "counted"]) {
          calls = []; assert.equal((await invoke(`/transport?handler=${handler}&method=POST&implicit=1`)).status, 200); samples.push(calls);
        }
        assert.deepEqual(samples[1], samples[0]);
        assert.equal(samples[1][1].contentType, "text/plain;charset=UTF-8");
      });
    }
    await t.test("stops at the invocation limit before the next HTTP request", async () => {
      scenario = { redirects: 10, status: 307, crossHost: false }; calls = [];
      const result = await invoke("/transport?reserved=49");
      assert.equal(result.error, "CronBudgetExceeded"); assert.equal(result.resources.externalRequests, 1); assert.equal(calls.length, 1);
    });
    for (const redirects of [0, 10, 20]) {
      await t.test(`resumes all three channels with ${redirects} redirects, surviving worker restart`, async () => {
        scenario = { redirects, status: 307, crossHost: false }; calls = [];
        assert.equal((await invoke("/transport?handler=native&method=POST&sends=3")).status, 200);
        const nativeCalls = calls.length;
        assert.equal(nativeCalls, (redirects + 1) * 3);
        assert.equal((await worker.fetch(`http://localhost/seed?endpoint=${encodeURIComponent(endpoint)}`)).status, 200);
        const ticks = [];
        for (let tick = 0; tick < 3; tick++) {
          calls = [];
          const result = await invoke(`/tick?content=${tick === 0 ? "frozen" : "changed"}`);
          assert.equal(result.resources.externalRequests, calls.length);
          assert.equal(calls.length, redirects + 1); assert.ok(result.resources.sql <= 50);
          assert.equal(result.row.attempts, 1); assert.equal(result.row.status, tick === 2 ? "sent" : "pending");
          assert.equal(result.result, tick === 2 ? "settled" : "keep_due");
          const history = JSON.parse(result.history.result_json);
          assert.equal(history.message.content, "frozen"); assert.equal(history.channels.succeeded.length, tick + 1);
          assert.equal(Object.hasOwn(history, "deliveryPending"), false);
          ticks.push(result.resources);
          if (tick === 0) { await worker.stop(); worker = await start(); }
        }
        calls = []; assert.equal((await invoke("/tick")).result, "settled"); assert.equal(calls.length, 0);
        t.diagnostic(JSON.stringify({ redirects, nativeCalls, ticks }));
      });
    }
  } finally {
    if (worker) await worker.stop();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
