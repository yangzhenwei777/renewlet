import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "jsonc-parser";
import { unstable_dev } from "wrangler";

test("cloud backup uses the deployed Wrangler runtime entry", { timeout: 60_000 }, async (t) => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const config = parse(await readFile(join(root, "wrangler.jsonc"), "utf8"));
  const rootRequire = createRequire(join(root, "package.json"));
  const workerRequire = createRequire(join(root, "apps/worker/package.json"));
  const sdkRequire = createRequire(workerRequire.resolve("@aws-sdk/client-s3"));
  const protocolRequire = createRequire(sdkRequire.resolve("@aws-sdk/core"));
  // SDK 升级必须同步构建入口依赖，禁止 alias 静默固定到另一版协议实现。
  assert.equal(rootRequire.resolve(config.alias["@aws-sdk/xml-builder"]), protocolRequire.resolve("@aws-sdk/xml-builder"));
  await mkdir(join(root, ".wrangler"), { recursive: true });
  const directory = await mkdtemp(join(root, ".wrangler/s3-runtime-"));
  const configPath = join(directory, "wrangler.json");
  await writeFile(configPath, JSON.stringify({
    name: "renewlet-s3-runtime-test",
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    alias: config.alias,
  }));
  let worker;
  try {
    // 复用部署配置的解析入口；Node 单测即使移除 DOMParser，也无法覆盖 Wrangler 的 browser 重定向。
    worker = await unstable_dev(join(root, "scripts/fixtures/cloud-backup-runtime.ts"), {
      config: configPath,
      local: true,
      ip: "127.0.0.1",
      port: 0,
      inspectorPort: 0,
      persist: false,
      envFiles: [],
      logLevel: "error",
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
    });
    await t.test("keeps the existing ZIP bytes with the deployed CRC32 runtime", async () => {
      const response = await worker.fetch("http://localhost/?scenario=zip");
      assert.equal(response.status, 200);
      const archive = Buffer.from(await response.arrayBuffer());
      // 基线来自旧写入器并经独立ZIP读取器校验；整包hash同时保护CRC、记录偏移和确定性格式。
      assert.equal(createHash("sha256").update(archive).digest("hex"), "057a8e1eda5f2d50ec8f6af9da33431e1049cab7e9d22cadb925aa540f08f2b3");
    });
    for (const scenario of ["root", "pages"]) {
      await t.test(`parses ${scenario} listing and reads only its manifest`, async () => {
        const response = await worker.fetch(`http://localhost/?scenario=${scenario}`);
        const result = await response.json();
        assert.equal(response.status, 200, JSON.stringify(result));
        assert.equal(result.snapshots.length, 1);
        assert.equal(result.snapshots[0].filename, "renewlet-export-v1-20261004T182855Z-4c43d1e5.zip");
        const lists = result.calls.filter((call) => call.maxKeys !== null);
        assert.deepEqual(lists.map((call) => call.token), scenario === "pages" ? [null, "next-page"] : [null]);
        assert.ok(lists.every((call) => call.maxKeys === "1000" && call.prefix === (scenario === "pages" ? "backups/" : null)));
        assert.equal(result.calls.length, lists.length + 1);
        assert.ok(result.calls.every((call) => call.method === "GET" && !call.path.endsWith(".zip")));
        assert.ok(result.calls.every((call) => call.cache === "no-store" && call.signed));
      });
    }
    for (const scenario of ["forbidden", "invalid-xml"]) {
      await t.test(`preserves ${scenario} diagnostics`, async () => {
        const response = await worker.fetch(`http://localhost/?scenario=${scenario}`);
        const result = await response.json();
        assert.equal(response.status, 400);
        assert.equal(result.code, "CLOUD_BACKUP_S3_LIST_FAILED");
        assert.equal(result.calls.length, 1);
        assert.equal(result.details.httpStatus, scenario === "forbidden" ? 403 : 200);
        if (scenario === "forbidden") {
          assert.equal(result.details.providerCode, "AccessDenied");
          assert.equal(result.details.requestId, "forbidden-request");
          assert.equal(result.details.requiredCapability, "bucket listing permission");
          assert.equal(result.details.clientMessage, undefined);
        } else {
          assert.equal(result.details.providerCode, undefined);
          assert.match(result.details.clientMessage, /XML parse error/);
          assert.equal(result.details.providerMessage, "not xml");
        }
      });
    }
    // workerd 能验证 SDK 交给 fetch 的缓存策略，不能模拟线上 CDN 的 HEAD 改写；实际部署仍需单独确认。
    for (const scenario of ["upload", "head-forbidden", "manifest-forbidden"]) {
      await t.test(`keeps signed ZIP requests uncached through ${scenario}`, async () => {
        const response = await worker.fetch(`http://localhost/?scenario=${scenario}`);
        const result = await response.json();
        assert.ok(result.calls.every((call) => call.cache === "no-store" && call.signed));
        assert.equal(result.remainingObjects, 0);
        assert.ok(result.calls[1].path.endsWith(".zip"));
        if (scenario === "upload") {
          assert.equal(response.status, 200, JSON.stringify(result));
          assert.equal(result.content, "backup-content");
          assert.deepEqual(result.calls.map((call) => call.method), ["PUT", "HEAD", "PUT", "GET", "GET", "DELETE", "DELETE"]);
        } else {
          assert.equal(response.status, 400);
          assert.equal(result.details.httpStatus, 403);
          assert.equal(result.details.clientMessage, undefined);
          assert.equal(result.details.cleanup, undefined);
          if (scenario === "head-forbidden") {
            assert.equal(result.code, "CLOUD_BACKUP_S3_HEAD_FAILED");
            assert.equal(result.details.requestId, "head-request");
            assert.equal(result.details.providerCode, undefined);
            assert.equal(result.details.providerMessage, undefined);
            assert.deepEqual(result.calls.map((call) => call.method), ["PUT", "HEAD", "DELETE"]);
          } else {
            assert.equal(result.code, "CLOUD_BACKUP_S3_PUT_FAILED");
            assert.equal(result.details.providerCode, "AccessDenied");
            assert.match(result.details.providerMessage, /Manifest rejected/);
            assert.deepEqual(result.calls.map((call) => call.method), ["PUT", "HEAD", "PUT", "DELETE", "DELETE"]);
          }
        }
      });
    }
  } finally {
    await worker?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
