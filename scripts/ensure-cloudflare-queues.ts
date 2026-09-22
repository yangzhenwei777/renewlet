#!/usr/bin/env node
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject, readWranglerConfig } from "./cloudflare-wrangler-config";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(repoRoot, process.env["CI_WRANGLER_CONFIG"] || "wrangler.jsonc");

function readQueueNames(): string[] {
  const config = readWranglerConfig(configPath);
  const queuesConfig = config["queues"];
  if (!isJsonObject(queuesConfig)) return [];
  const queues = new Set<string>();
  for (const producer of Array.isArray(queuesConfig["producers"]) ? queuesConfig["producers"] : []) {
    if (isJsonObject(producer) && typeof producer["queue"] === "string" && producer["queue"].trim()) {
      queues.add(producer["queue"].trim());
    }
  }
  for (const consumer of Array.isArray(queuesConfig["consumers"]) ? queuesConfig["consumers"] : []) {
    if (!isJsonObject(consumer)) continue;
    if (typeof consumer["queue"] === "string" && consumer["queue"].trim()) queues.add(consumer["queue"].trim());
    if (typeof consumer["dead_letter_queue"] === "string" && consumer["dead_letter_queue"].trim()) {
      queues.add(consumer["dead_letter_queue"].trim());
    }
  }
  return [...queues];
}

function commandOutput(result: SpawnSyncReturns<string>): string {
  return [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
}

function runWranglerQueueCommand(command: string, name: string): SpawnSyncReturns<string> {
  return spawnSync("pnpm", ["exec", "wrangler", "queues", command, name, "--config", configPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
}

function queueMissing(output: string): boolean {
  return /does not exist|queues lookup missing queue/i.test(output);
}

function queueCreateConflict(output: string): boolean {
  return /\b11009\b|already taken/i.test(output);
}

function queueExists(name: string): boolean {
  const result = runWranglerQueueCommand("info", name);
  const output = commandOutput(result);
  if (result.status === 0) return true;
  if (queueMissing(output)) return false;
  throw new Error(`Failed to inspect Cloudflare Queue ${name}:\n${output.trim()}`);
}

function ensureQueue(name: string): void {
  if (queueExists(name)) {
    console.log(`Cloudflare Queue ready: ${name}`);
    return;
  }

  const result = runWranglerQueueCommand("create", name);
  const output = commandOutput(result);
  if (result.status === 0) {
    console.log(`Cloudflare Queue ready: ${name}`);
    return;
  }

  if (queueCreateConflict(output)) {
    // Queue create 不是幂等 API；并发部署撞 11009 后必须重新读回，不能仅凭错误文本假装成功。
    try {
      if (queueExists(name)) {
        console.log(`Cloudflare Queue ready: ${name}`);
        return;
      }
    } catch (error) {
      throw new Error([
        `Cloudflare Queue ${name} create conflicted but the queue could not be confirmed:`,
        output.trim(),
        error instanceof Error ? error.message : String(error),
      ].filter(Boolean).join("\n"));
    }
    throw new Error(`Cloudflare Queue ${name} create conflicted but the queue could not be confirmed:\n${output.trim()}`);
  }

  throw new Error(`Failed to create Cloudflare Queue ${name}:\n${output.trim()}`);
}

function main(): void {
  const queues = readQueueNames();
  if (queues.length === 0) {
    console.log("No Cloudflare Queues configured.");
    return;
  }
  // 队列名只来自 normal Wrangler 配置，生成配置覆盖名称后不会遗漏 producer 或 DLQ。
  for (const queue of queues) ensureQueue(queue);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
