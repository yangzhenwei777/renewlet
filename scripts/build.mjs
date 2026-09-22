/**
 * 根 build 分流入口。
 *
 * 触发时机：根 `pnpm build`、Cloudflare Workers Builds 和本地/CI Docker 构建。
 * 环境变量：`WORKERS_CI=1` 时切到 Cloudflare Static Assets + Worker 构建；其它场景保持 Docker/Go/PocketBase 构建链。
 *
 * 注意：这个脚本只转发命令，不做额外环境探测，避免 Cloudflare 构建和 Docker 构建互相污染产物。
 */
import { spawnSync } from "node:child_process";

const target = process.env.WORKERS_CI === "1" ? "build:cloudflare" : "build:docker";
const result = spawnSync("pnpm", ["run", target], { stdio: "inherit", shell: process.platform === "win32" });

process.exit(result.status ?? 1);
