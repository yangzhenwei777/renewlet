#!/usr/bin/env node

/**
 * AI 识别提示词同步器。
 *
 * 触发时机：维护 shared prompt 后运行；`--check` 用于 CI/Cloudflare 检查确认生成物未漂移。
 * 输入：`packages/shared/data/ai-recognition-prompt.json`；副作用：无参数会重写 Go embedded static 副本。
 *
 * 架构位置：shared JSON 是事实源，Go 二进制只读取嵌入副本，Worker 直接从 shared 包读取同一语义。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(repoRoot, "packages/shared/data/ai-recognition-prompt.json");
const serverPath = path.join(repoRoot, "apps/docker-server/internal/static/data/ai-recognition-prompt.json");
const checkOnly = process.argv.includes("--check");

const source = await readFile(sourcePath, "utf8");
const current = await readFile(serverPath, "utf8").catch(() => "");

if (source === current) {
  console.log("AI recognition prompt is in sync");
  process.exit(0);
}

if (checkOnly) {
  throw new Error("apps/docker-server/internal/static/data/ai-recognition-prompt.json is out of sync with packages/shared/data/ai-recognition-prompt.json");
}

await mkdir(path.dirname(serverPath), { recursive: true });
await writeFile(serverPath, source, "utf8");
console.log("synced AI recognition prompt to server embedded data");
