import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "jsonc-parser";
import { unstable_dev } from "wrangler";

const md5 = (value) => createHash("md5").update(value).digest("hex");
function validDigest(header, method, path) {
  const values = Object.fromEntries([...header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map(([, name, quoted, plain]) => [name, quoted ?? plain]));
  const { username, realm, nonce, uri, nc, cnonce, qop, response } = values;
  return username === "fixture-user" && realm === "fixture" && nonce === "fixture-nonce" && uri === path && qop === "auth"
    && response === md5(`${md5("fixture-user:fixture:fixture-password")}:${nonce}:${nc}:${cnonce}:${qop}:${md5(`${method}:${uri}`)}`);
}
function davResponse(path, directory, size) {
  return `<d:response><d:href>${path}</d:href><d:propstat><d:prop><d:displayname>${directory ? "dav" : "file"}</d:displayname><d:resourcetype>${directory ? "<d:collection/>" : ""}</d:resourcetype><d:getcontentlength>${size}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

test("WebDAV official adapter counts workerd requests including Auto/Digest exchanges", { timeout: 120_000 }, async (t) => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const config = parse(await readFile(join(root, "wrangler.jsonc"), "utf8"));
  await mkdir(join(root, ".wrangler"), { recursive: true });
  const directory = await mkdtemp(join(root, ".wrangler/webdav-transport-"));
  const configPath = join(directory, "wrangler.json");
  await writeFile(configPath, JSON.stringify({ name: "renewlet-webdav-transport-test", compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags }));
  let calls = [];
  let scenario = { redirects: 0, auth: "digest" };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const authorization = request.headers.authorization ?? "";
    const digest = authorization.startsWith("Digest ");
    const hop = calls.filter((call) => call.path === request.url).length % (scenario.redirects + 1);
    // 证据只保留认证方案和校验结果，不写Authorization或Digest原始参数。
    calls.push({ method: request.method, path: request.url, scheme: authorization.split(" ")[0],
      validDigest: digest && validDigest(authorization, request.method, request.url),
      contentType: request.headers["content-type"], depth: request.headers.depth,
      bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    if (hop < scenario.redirects) {
      response.writeHead(307, { location: request.url }); response.end("redirect"); return;
    }
    if (scenario.auth === "digest" && !digest) {
      response.writeHead(401, { "www-authenticate": 'Digest realm="fixture", nonce="fixture-nonce", qop="auth", algorithm=MD5' }); response.end("challenge"); return;
    }
    if ((digest && !validDigest(authorization, request.method, request.url)) || (scenario.auth === "basic" && authorization !== `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}`)) {
      response.writeHead(401); response.end("invalid fixture credentials"); return;
    }
    if (request.method === "PROPFIND") {
      const listing = request.headers.depth === "1";
      response.writeHead(207, { "content-type": "application/xml" });
      response.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${listing ? davResponse("/dav/", true, 0) : ""}${davResponse("/dav/file", false, 13)}</d:multistatus>`); return;
    }
    if (request.method === "GET") { response.writeHead(200); response.end("fixture-bytes"); return; }
    response.writeHead(request.method === "DELETE" ? 204 : 201); response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}/dav`;
  let worker;
  try {
    worker = await unstable_dev(join(root, "apps/worker/test-fixtures/webdav-transport.ts"), {
      config: configPath, local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0, envFiles: [], logLevel: "error",
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
    });
    const run = async (handler, extra = "") => {
      calls = [];
      const response = await worker.fetch(`http://localhost/?endpoint=${encodeURIComponent(endpoint)}&handler=${handler}&auth=${scenario.auth}${extra}`);
      assert.equal(response.status, 200, await response.clone().text());
      return { result: await response.json(), calls };
    };
    for (const auth of ["none", "basic", "digest"]) {
      for (const redirects of [0, 1, 10, 15, 16, 20, 21]) {
        await t.test(`${auth} GET with ${redirects} redirects per exchange`, async () => {
          scenario = { auth, redirects };
          const native = await run("native");
          const counted = await run("counted");
          assert.equal(counted.result.resources.externalRequests, counted.calls.length);
          assert.equal(counted.result.resources.externalReserved, 0);
          assert.ok(counted.calls.length <= 50);
          assert.deepEqual(counted.calls, native.calls.slice(0, 50));
          if (redirects > 20) {
            assert.ok(native.result.error); assert.ok(counted.result.error);
          } else if (auth === "digest" && redirects >= 16) {
            assert.equal(native.result.value, "fixture-bytes");
            assert.equal(counted.result.error, "WebDAVOperationLimitExceeded");
            assert.equal(counted.calls.length, 50);
          } else {
            assert.equal(native.result.value, "fixture-bytes");
            assert.equal(counted.result.value, native.result.value);
          }
          process.stdout.write(`${JSON.stringify({ environment: "local workerd + loopback HTTP (not cloud CPU)", auth, redirects, nativeRequests: native.calls.length, countedRequests: counted.calls.length, error: counted.result.error ?? null })}\n`);
        });
      }
    }
    for (const operation of ["put", "stat", "list", "delete", "directory"]) {
      await t.test(`preserves Digest authentication and ${operation} method/body through redirects`, async () => {
        scenario = { auth: "digest", redirects: 10 };
        const native = await run("native", `&operation=${operation}`);
        const counted = await run("counted", `&operation=${operation}`);
        assert.equal(native.result.error, undefined, JSON.stringify(native.result));
        assert.equal(counted.result.error, undefined, JSON.stringify(counted.result));
        assert.deepEqual(counted.calls, native.calls);
        assert.deepEqual(counted.result.value, native.result.value);
        assert.equal(counted.result.resources.externalRequests, counted.calls.length);
        assert.equal(counted.calls.length, 33);
        assert.ok(counted.calls.slice(-11).every((call) => call.validDigest));
      });
    }
    await t.test("concurrent operations keep separate budgets in the same workerd isolate", async () => {
      scenario = { auth: "basic", redirects: 1 }; calls = [];
      const result = await (await worker.fetch(`http://localhost/parallel?endpoint=${encodeURIComponent(endpoint)}&auth=basic`)).json();
      assert.equal(result[0].error, "CronBudgetExceeded");
      assert.equal(result[0].resources.externalRequests, 1);
      assert.equal(result[1].value, "fixture-bytes");
      assert.equal(result[1].resources.externalRequests, 2);
      assert.equal(result[2].value, "fixture-bytes");
      assert.equal(result[2].resources.externalRequests, 0);
      assert.equal(calls.filter((call) => call.path.includes("limited")).length, 1);
      assert.equal(calls.filter((call) => call.path.includes("counted")).length, 2);
      assert.equal(calls.filter((call) => call.path.includes("manual")).length, 2);
    });
    await t.test("a partially spent invocation stops before sending request 51", async () => {
      scenario = { auth: "digest", redirects: 10 };
      const { result } = await run("counted", "&reserved=49");
      assert.equal(result.error, "CronBudgetExceeded");
      assert.equal(result.resources.externalRequests, 1);
      assert.equal(calls.length, 1);
    });
  } finally {
    await worker?.stop(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
