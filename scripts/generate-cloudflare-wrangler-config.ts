#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isJsonObject,
  readWranglerConfig,
  writeWranglerConfigPair,
  type JsonValue,
  type WranglerConfig,
} from "./cloudflare-wrangler-config";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = join(repoRoot, "wrangler.jsonc");
const outputPath = resolve(repoRoot, process.env["CI_WRANGLER_CONFIG"] || "wrangler.generated.jsonc");
const maintenanceOutputPath = resolve(
  repoRoot,
  process.env["CI_WRANGLER_MAINTENANCE_CONFIG"] || "wrangler.maintenance.generated.jsonc",
);

const requiredEnvironment = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "WORKER_NAME",
  "D1_DATABASE_ID",
  "R2_BUCKET_NAME",
  "CLOUDFLARE_OBSERVABILITY_PROFILE",
] as const;

const observabilityProfiles = {
  development: { logs: 1, traces: 1 },
  production: { logs: 0.1, traces: 0.05 },
} as const;

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function findBinding(config: WranglerConfig, key: string, binding: string): WranglerConfig {
  const bindings = config[key];
  if (!Array.isArray(bindings)) throw new Error(`wrangler.jsonc must contain ${key}`);
  const match = bindings.find((item) => isJsonObject(item) && item["binding"] === binding);
  if (!isJsonObject(match)) throw new Error(`wrangler.jsonc must contain ${binding} in ${key}`);
  return match;
}

for (const name of requiredEnvironment) requireEnvironment(name);

const config = readWranglerConfig(templatePath);
config["name"] = requireEnvironment("WORKER_NAME");
const profile = requireEnvironment("CLOUDFLARE_OBSERVABILITY_PROFILE");
if (profile !== "development" && profile !== "production") {
  throw new Error("CLOUDFLARE_OBSERVABILITY_PROFILE must be development or production");
}
const sampling = observabilityProfiles[profile];
// 采样 profile 由部署入口显式选择，避免 fork 或开发部署继承生产观测成本。
config["observability"] = {
  enabled: true,
  logs: { enabled: true, head_sampling_rate: sampling.logs },
  traces: { enabled: true, head_sampling_rate: sampling.traces },
};

findBinding(config, "d1_databases", "DB")["database_id"] = requireEnvironment("D1_DATABASE_ID");
findBinding(config, "r2_buckets", "ASSETS_BUCKET")["bucket_name"] = requireEnvironment("R2_BUCKET_NAME");

const vars: WranglerConfig = isJsonObject(config["vars"]) ? config["vars"] : {};
const buildVariables: Record<string, JsonValue> = {};
for (const name of ["RENEWLET_VERSION", "RENEWLET_COMMIT", "RENEWLET_BUILD_TIME"] as const) {
  const value = process.env[name]?.trim();
  if (value) buildVariables[name] = value;
}
config["vars"] = {
  ...vars,
  ...buildVariables,
  RENEWLET_MAINTENANCE_MODE: "false",
};

writeWranglerConfigPair(outputPath, maintenanceOutputPath, config);
console.log(`Generated Cloudflare Wrangler configs: ${outputPath}, ${maintenanceOutputPath} (${profile})`);
