#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number.parseInt(process.env.RENEWLET_WORKERD_PROBE_PORT ?? "8797", 10);
const probeUrl = `http://127.0.0.1:${Number.isFinite(port) ? port : 8797}`;
const tempDir = await mkdtemp(join(tmpdir(), "renewlet-workerd-probe-"));
const workerPath = join(tempDir, "worker.mjs");

await writeFile(workerPath, `
const target = "https://discord.com/api/webhooks/0/invalid-renewlet-upstream-probe?wait=true";

export default {
  async fetch() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "renewlet workerd upstream probe" }),
        signal: controller.signal,
      });
      const body = await response.text();
      return Response.json({
        ok: true,
        status: response.status,
        statusText: response.statusText,
        body: body.slice(0, 512),
      });
    } catch (error) {
      return Response.json({
        ok: false,
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
        causeCode: error && typeof error === "object" && "cause" in error && error.cause && typeof error.cause === "object" && "code" in error.cause ? String(error.cause.code) : null,
      }, { status: 502 });
    } finally {
      clearTimeout(timeout);
    }
  },
};
`, "utf8");

const child = spawn(wranglerBin(), ["dev", workerPath, "--ip", "127.0.0.1", "--port", String(port), "--local"], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});
const childExit = new Promise((resolve) => child.once("exit", resolve));
const childError = new Promise((_, reject) => child.once("error", reject));

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

try {
  const result = await Promise.race([waitForProbe(probeUrl, 20_000), childError]);
  console.log(JSON.stringify({
    runtime: "workerd",
    target: "https://discord.com/api/webhooks/0/[redacted]?wait=true",
    result,
  }, null, 2));
} catch (error) {
  console.error("workerd upstream probe failed to start or respond.");
  console.error(error instanceof Error ? error.message : String(error));
  if (output.trim()) {
    console.error("\nwrangler output:");
    console.error(output.trim().slice(-4000));
  }
  process.exitCode = 1;
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await Promise.race([childExit, sleep(2000)]);
  await rm(tempDir, { recursive: true, force: true });
}

function wranglerBin() {
  return process.platform === "win32" ? "wrangler.cmd" : "wrangler";
}

async function waitForProbe(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      return {
        workerStatus: response.status,
        body: await response.json(),
      };
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw lastError ?? new Error("probe timed out waiting for wrangler dev");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
