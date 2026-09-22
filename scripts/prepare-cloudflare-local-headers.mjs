#!/usr/bin/env node
/**
 * Cloudflare 本地 HTTP dev headers 准备。
 *
 * 触发时机：`pnpm dev:cloudflare` 在前端 Cloudflare 构建完成后、Wrangler 启动前运行。
 * 安全边界：只放宽 ignored 的 dist `_headers`，生产源 `_headers` 和正式部署仍保留 HTTPS 强化 CSP。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distHeadersPath = join(repoRoot, "apps/web/dist/_headers");

const productionUpgradeDirective = "upgrade-insecure-requests";
const productionImageDirective = "img-src 'self' data: blob: https:";
const localImageDirective = "img-src 'self' data: blob: http: https:";

if (!existsSync(distHeadersPath)) {
  throw new Error("Missing apps/web/dist/_headers. Run pnpm build:cloudflare before preparing local headers or deploying.");
}

const headers = readFileSync(distHeadersPath, "utf8");
const checkProduction = process.argv.includes("--check-production");

if (checkProduction) {
  assertProductionHeaders(headers);
  console.log("Cloudflare production headers check passed.");
} else {
  const nextHeaders = prepareLocalHeaders(headers);
  writeFileSync(distHeadersPath, nextHeaders);
  console.log("Prepared Cloudflare local HTTP headers: removed upgrade-insecure-requests from apps/web/dist/_headers.");
}

function prepareLocalHeaders(headersContent) {
  const { linePattern, prefix, policy } = parseContentSecurityPolicy(headersContent);
  if (!policy.includes(productionUpgradeDirective) && policy.includes(localImageDirective)) {
    return headersContent;
  }
  if (!policy.includes(productionUpgradeDirective)) {
    throw new Error("Expected production CSP to include upgrade-insecure-requests before preparing local headers.");
  }
  if (!policy.includes(productionImageDirective)) {
    throw new Error(`Expected production CSP to include ${productionImageDirective}.`);
  }

  const localPolicy = policy
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .filter((directive) => directive !== productionUpgradeDirective)
    .map((directive) => (directive === productionImageDirective ? localImageDirective : directive))
    .join("; ");

  return headersContent.replace(linePattern, `${prefix}${localPolicy}`);
}

function assertProductionHeaders(headersContent) {
  const { policy } = parseContentSecurityPolicy(headersContent);
  if (!policy.includes(productionUpgradeDirective)) {
    throw new Error("Cloudflare production dist _headers must include upgrade-insecure-requests. Run pnpm build:cloudflare before deploy.");
  }
  if (policy.includes(localImageDirective) || !policy.includes(productionImageDirective)) {
    throw new Error("Cloudflare production dist _headers must keep HTTPS-only img-src. Run pnpm build:cloudflare before deploy.");
  }
}

function parseContentSecurityPolicy(headersContent) {
  const cspLinePattern = /^(\s*Content-Security-Policy:\s*)(.+)$/m;
  const match = cspLinePattern.exec(headersContent);
  if (!match) {
    throw new Error("Missing Content-Security-Policy in apps/web/dist/_headers.");
  }
  return {
    linePattern: cspLinePattern,
    prefix: match[1],
    policy: match[2],
  };
}
