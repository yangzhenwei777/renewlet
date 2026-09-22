#!/usr/bin/env node

/**
 * 媒体解析配置同步器。
 *
 * 触发时机：维护 shared media resolver 配置后运行；`--check` 用于 CI/Cloudflare 检查确认生成物未漂移。
 * 输入：`packages/shared/data/media-resolver-config.json`；副作用：无参数会重写 Go embedded static 副本。
 *
 * 契约：Docker 后端、Worker 和前端必须共用同一 provider 排序、候选预算和降词规则。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(repoRoot, "packages/shared/data/media-resolver-config.json");
const serverPath = path.join(repoRoot, "apps/docker-server/internal/static/data/media-resolver-config.json");
const checkOnly = process.argv.includes("--check");

const source = await readFile(sourcePath, "utf8");
const current = await readFile(serverPath, "utf8").catch(() => "");

if (source === current) {
  console.log("media resolver config is in sync");
  process.exit(0);
}

if (checkOnly) {
  throw new Error("apps/docker-server/internal/static/data/media-resolver-config.json is out of sync with packages/shared/data/media-resolver-config.json");
}

await mkdir(path.dirname(serverPath), { recursive: true });
await writeFile(serverPath, source, "utf8");
console.log("synced media resolver config to server embedded data");
