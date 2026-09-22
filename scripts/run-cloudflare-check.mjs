#!/usr/bin/env node

/**
 * Cloudflare 线上巡检入口。
 *
 * 触发时机：`pnpm test:e2e:cloudflare*` 手动或 CI 烟测调用。
 * 前置依赖：Node 24、pnpm、Playwright 浏览器，以及本地 `cloudflare-check.env.local`
 * 或显式传入的 RENEWLET_E2E_* 环境变量。
 *
 * 业务意图：把部署域名和测试账号固定到本地 env 文件，避免线上验收依赖聊天记录里的临时命令。
 * 约束：shell 已显式传入的变量优先；本地文件只补缺省值，不能覆盖 CI 或人工指定的目标站点。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const localEnvFile = resolve(repoRoot, "cloudflare-check.env.local");
const exampleEnvFile = resolve(repoRoot, "cloudflare-check.env.example");
const placeholderValues = new Set([
  "https://renewlet.example.com",
  "admin@example.com",
  "change-me",
  "https://你的部署域名",
  "测试管理员邮箱",
  "测试管理员密码",
]);

function usage() {
  console.log(`
Cloudflare deployed-site E2E check.

First-time setup:
  cp cloudflare-check.env.example cloudflare-check.env.local
  # edit cloudflare-check.env.local with your deployed Worker URL and test admin account

Run:
  pnpm test:e2e:cloudflare
  pnpm test:e2e:cloudflare:headed
  pnpm test:e2e:cloudflare:ui

One-off override:
  RENEWLET_E2E_BASE_URL=https://renewlet.example.workers.dev pnpm test:e2e:cloudflare

Options:
  --readonly   Force RENEWLET_E2E_WRITE_SCOPE=readonly for this run.
  --headed     Show the browser.
  --ui         Open Playwright UI mode.
  --help       Show this help.
`);
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(withoutExport);
  if (!match) return null;
  const [, key, rawValue] = match;
  return [key, unquoteEnvValue(rawValue.trim())];
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function loadLocalEnv() {
  if (!existsSync(localEnvFile)) return false;
  const content = readFileSync(localEnvFile, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (!entry) continue;
    const [key, value] = entry;
    // shell/CI 显式变量优先，避免本地巡检文件意外覆盖生产烟测目标或只读范围。
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}

function cleanArgv(argv) {
  return argv.filter((arg) => arg !== "--");
}

function requireRunnableEnv(envLoaded) {
  const baseURL = process.env.RENEWLET_E2E_BASE_URL?.trim() ?? "";
  if (!baseURL || placeholderValues.has(baseURL)) {
    const loadedText = envLoaded ? `已读取 ${localEnvFile}，但 RENEWLET_E2E_BASE_URL 仍是空值或占位值。` : `未找到 ${localEnvFile}。`;
    throw new Error(`${loadedText}

请先执行：
  cp ${exampleEnvFile} ${localEnvFile}
  # 编辑 ${localEnvFile}
  pnpm test:e2e:cloudflare`);
  }

  const email = process.env.RENEWLET_E2E_EMAIL?.trim() ?? "";
  const password = process.env.RENEWLET_E2E_PASSWORD?.trim() ?? "";
  if (placeholderValues.has(email) || placeholderValues.has(password)) {
    throw new Error(`${localEnvFile} 里的测试管理员账号仍是占位值。`);
  }
  if (!email || !password) {
    console.warn("未设置 RENEWLET_E2E_EMAIL / RENEWLET_E2E_PASSWORD，本次只运行公开路由巡检。");
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  // 子进程退出码原样透传给 pnpm script，保证 typecheck 或 Playwright 失败不会被包装脚本吞掉。
  process.exitCode = result.status ?? 1;
  return process.exitCode;
}

function main() {
  const args = cleanArgv(process.argv.slice(2));
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  const envLoaded = loadLocalEnv();
  if (envLoaded) {
    console.log(`Loaded Cloudflare check env: ${localEnvFile}`);
  }

  const playwrightArgs = ["test", "--config=playwright.cloudflare-check.config.ts"];
  if (args.includes("--readonly")) {
    // 线上只读巡检必须在进入 Playwright 前收敛成 env，spec 再据此跳过临时写入/删除旅程。
    process.env.RENEWLET_E2E_WRITE_SCOPE = "readonly";
  }
  if (args.includes("--headed")) {
    playwrightArgs.push("--headed");
  }
  if (args.includes("--ui")) {
    playwrightArgs.push("--ui");
  }
  playwrightArgs.push(...args.filter((arg) => !["--readonly", "--headed", "--ui"].includes(arg)));

  requireRunnableEnv(envLoaded);
  if (run("pnpm", ["typecheck:e2e"]) !== 0) return;
  run("pnpm", ["exec", "playwright", ...playwrightArgs]);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
