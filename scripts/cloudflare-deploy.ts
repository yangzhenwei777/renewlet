#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  captureBookmark,
  deploymentRecoveryCommand,
  validateBookmark,
  writeDeploymentCheckpointEvidence,
  writeDeploymentRecoveryHint,
} from "./cloudflare-d1-checkpoint";
import { createD1OperationsClient } from "./cloudflare-d1-operations";
import {
  createMaintenanceWranglerConfig,
  isJsonObject,
  readWranglerConfig,
  writeWranglerConfig,
  type WranglerConfig,
} from "./cloudflare-wrangler-config";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const drainWindowMs = 15 * 60 * 1000;

interface ActiveDeployment {
  versionId: string;
}

interface D1TriggerDefinition {
  name: string;
  sql: string;
}

interface DeployOptions {
  configPath: string;
  maintenanceConfigPath: string;
}

interface RecoveryOptions extends DeployOptions {
  bookmark: string;
  workerVersion: string;
}

export interface DeploymentOperations {
  prepare(): Promise<void>;
  ensureQueues(): Promise<void>;
  readActiveDeployment(): Promise<ActiveDeployment | undefined>;
  readAppliedExclusiveMigrations(names: readonly string[]): Promise<Set<string>>;
  captureBookmark(): Promise<string>;
  deployMaintenance(): Promise<ActiveDeployment>;
  waitForBackgroundDrain(): Promise<void>;
  applyMigrations(): Promise<void>;
  verifyDatabase(names: readonly string[]): Promise<void>;
  deployNormal(): Promise<ActiveDeployment>;
  restoreWorker(versionId: string): Promise<void>;
  restoreDatabase(bookmark: string): Promise<void>;
  recordCheckpoint(bookmark: string, versionId?: string): void;
  recordRecoveryHint(bookmark: string, versionId: string): void;
}

function exclusiveMigrationNames(): string[] {
  return readdirSync(resolve(repoRoot, "apps/worker/migrations"))
    .filter((name) => /^\d{4}_exclusive_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

function combineFailure(primary: unknown, containment: unknown, action: string): Error {
  const primaryMessage = primary instanceof Error ? primary.message : String(primary);
  const containmentMessage = containment instanceof Error ? containment.message : String(containment);
  return new Error(`${primaryMessage}\n${action} also failed: ${containmentMessage}`);
}

async function restoreBeforeDatabaseWrite(
  operations: DeploymentOperations,
  previous: ActiveDeployment,
  failure: unknown,
): Promise<never> {
  try {
    await operations.restoreWorker(previous.versionId);
  } catch (restoreError) {
    throw combineFailure(failure, restoreError, "Restoring the previous Worker");
  }
  throw failure;
}

async function containAfterDatabaseWrite(
  operations: DeploymentOperations,
  bookmark: string,
  previous: ActiveDeployment,
  failure: unknown,
): Promise<never> {
  operations.recordRecoveryHint(bookmark, previous.versionId);
  try {
    await operations.deployMaintenance();
  } catch (maintenanceError) {
    throw combineFailure(failure, maintenanceError, "Re-deploying maintenance mode");
  }
  throw failure;
}

/** 排他 migration 只有在旧后台执行完全排空后才能首次写 D1；写入后任何失败都保持 fail-closed。 */
export async function runCloudflareDeployment(operations: DeploymentOperations, names: readonly string[]): Promise<void> {
  await operations.prepare();
  await operations.ensureQueues();

  const previous = await operations.readActiveDeployment();
  const applied = await operations.readAppliedExclusiveMigrations(names);
  const pending = names.filter((name) => !applied.has(name));
  const bookmark = await operations.captureBookmark();
  operations.recordCheckpoint(bookmark, previous?.versionId);

  let maintenanceVersion: string | undefined;
  if (pending.length > 0 && previous !== undefined) {
    try {
      maintenanceVersion = (await operations.deployMaintenance()).versionId;
      if (maintenanceVersion === previous.versionId) {
        throw new Error("Maintenance deployment did not replace the previous Worker version");
      }
      await operations.waitForBackgroundDrain();
    } catch (error) {
      await restoreBeforeDatabaseWrite(operations, previous, error);
    }
  }

  // migration runner 的 Feed prepare 是本轮首次 D1 写入；调用一旦开始就不能假设失败前没有部分提交。
  try {
    await operations.applyMigrations();
    await operations.verifyDatabase(names);
    const normal = await operations.deployNormal();
    if (maintenanceVersion !== undefined && normal.versionId === maintenanceVersion) {
      throw new Error("Final Cloudflare deployment is still serving the maintenance Worker version");
    }
    await operations.verifyDatabase(names);
  } catch (error) {
    if (previous === undefined) throw error;
    await containAfterDatabaseWrite(operations, bookmark, previous, error);
  }
}

/** 人工恢复入口固定先恢复 D1，再回滚 Worker；反向顺序会让旧代码立即写入新数据契约。 */
export async function runCloudflareRecovery(operations: DeploymentOperations, options: RecoveryOptions): Promise<void> {
  await operations.prepare();
  await operations.ensureQueues();
  await operations.deployMaintenance();
  await operations.waitForBackgroundDrain();
  await operations.restoreDatabase(options.bookmark);
  try {
    await operations.restoreWorker(options.workerVersion);
  } catch (error) {
    try {
      await operations.deployMaintenance();
    } catch (maintenanceError) {
      throw combineFailure(error, maintenanceError, "Re-deploying maintenance mode after recovery");
    }
    throw error;
  }
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function runCommand(command: string, args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: repoRoot,
      env: environment,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", () => reject(new Error(`Unable to start ${command}`)));
    child.on("close", (status: number | null) => resolvePromise({ status, stdout, stderr }));
  });
}

function commandFailure(command: string, result: CommandResult): Error {
  const detail = [result.stderr.trim(), result.stdout.trim()].find((value) => value.length > 0);
  return new Error(detail ? `${command} failed: ${detail}` : `${command} failed`);
}

async function runPnpm(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<CommandResult> {
  return await runCommand("pnpm", args, environment);
}

async function requirePnpm(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<CommandResult> {
  const result = await runPnpm(args, environment);
  if (result.status !== 0) throw commandFailure(`pnpm ${args.join(" ")}`, result);
  return result;
}

function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${context} returned invalid JSON`);
  }
}

function parseActiveDeployment(value: unknown): ActiveDeployment {
  if (!isJsonObject(value) || !Array.isArray(value["versions"])) {
    throw new Error("Wrangler deployment status returned an invalid object");
  }
  const versions = value["versions"];
  if (versions.length !== 1 || !isJsonObject(versions[0])) {
    throw new Error("Renewlet deployment requires one active Worker version at 100% traffic");
  }
  const versionId = versions[0]["version_id"];
  const percentage = versions[0]["percentage"];
  if (typeof versionId !== "string" || versionId.length === 0 || percentage !== 100) {
    throw new Error("Renewlet deployment requires one active Worker version at 100% traffic");
  }
  return { versionId: safeWorkerVersion(versionId) };
}

function parseD1NameRow(value: unknown): string {
  if (!isJsonObject(value) || typeof value["name"] !== "string") {
    throw new Error("Cloudflare D1 migration query returned an invalid row");
  }
  return value["name"];
}

function parseD1CountRow(value: unknown): number {
  if (!isJsonObject(value) || typeof value["count"] !== "number" || !Number.isSafeInteger(value["count"])) {
    throw new Error("Cloudflare D1 invariant query returned an invalid count");
  }
  return value["count"];
}

function parseD1TriggerRow(value: unknown): D1TriggerDefinition {
  if (!isJsonObject(value) || typeof value["name"] !== "string" || typeof value["sql"] !== "string") {
    throw new Error("Cloudflare D1 trigger query returned an invalid row");
  }
  return { name: value["name"], sql: value["sql"] };
}

function normalizeD1TriggerSQL(value: string): string {
  return value.trim().replace(/;\s*$/, "").replace(/\s+/g, " ");
}

/** 不变量期望值直接来自不可变 migration，避免在部署器里复制第二份 trigger 契约。 */
export function exclusiveMigrationTriggerDefinitions(names: readonly string[]): Map<string, string> {
  const definitions = new Map<string, string>();
  const triggerPattern = new RegExp(
    String.raw`(CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z][A-Za-z0-9_]*)\b[\s\S]*?\bEND\s*;)`,
    "gi",
  );
  for (const name of names) {
    if (!/^\d{4}_exclusive_[a-z0-9_]+\.sql$/.test(name)) {
      throw new Error(`Invalid exclusive migration name: ${name}`);
    }
    const migration = readFileSync(resolve(repoRoot, "apps/worker/migrations", name), "utf8");
    for (const match of migration.matchAll(triggerPattern)) {
      const triggerName = match[2];
      const sql = match[1];
      if (!triggerName || !sql || definitions.has(triggerName)) {
        throw new Error(`Exclusive migration trigger definition is ambiguous: ${triggerName ?? name}`);
      }
      definitions.set(triggerName, normalizeD1TriggerSQL(sql));
    }
  }
  return definitions;
}

/** 同名 trigger 也必须逐定义一致，marker 和对象数量都不能证明数据库 guard 未被弱化。 */
export function assertD1TriggerDefinitions(
  expected: ReadonlyMap<string, string>,
  actual: readonly D1TriggerDefinition[],
): void {
  const actualByName = new Map<string, string>();
  for (const trigger of actual) {
    if (actualByName.has(trigger.name)) throw new Error(`Cloudflare D1 trigger ${trigger.name} is duplicated`);
    actualByName.set(trigger.name, normalizeD1TriggerSQL(trigger.sql));
  }
  for (const [name, sql] of expected) {
    const actualSQL = actualByName.get(name);
    if (actualSQL === undefined) throw new Error(`Cloudflare D1 trigger ${name} is missing`);
    if (actualSQL !== sql) throw new Error(`Cloudflare D1 trigger ${name} definition drifted`);
  }
  if (actualByName.size !== expected.size) {
    throw new Error("Cloudflare D1 returned unexpected exclusive migration triggers");
  }
}

function configuredQueueConsumers(config: WranglerConfig): WranglerConfig[] {
  const queues = config["queues"];
  if (!isJsonObject(queues) || !Array.isArray(queues["consumers"])) return [];
  return queues["consumers"].filter(isJsonObject);
}

function requiredString(config: WranglerConfig, key: string, context: string): string {
  const value = config[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${context} must define ${key}`);
  return value.trim();
}

function optionalNumber(config: WranglerConfig, key: string): number | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Queue consumer ${key} must be a number`);
  return value;
}

function appendNumberFlag(args: string[], flag: string, value: number | undefined): void {
  if (value !== undefined) args.push(flag, String(value));
}

function workerConsumerExists(payload: unknown, workerName: string): boolean {
  return Array.isArray(payload) && payload.some((consumer) => isJsonObject(consumer)
    && consumer["type"] === "worker"
    && (consumer["script_name"] === workerName || consumer["script"] === workerName || consumer["service"] === workerName));
}

async function restoreQueueConsumers(configPath: string): Promise<void> {
  const config = readWranglerConfig(configPath);
  const workerName = requiredString(config, "name", "Wrangler config");
  for (const consumer of configuredQueueConsumers(config)) {
    const queue = requiredString(consumer, "queue", "Queue consumer");
    const listed = await requirePnpm([
      "exec", "wrangler", "queues", "consumer", "worker", "list", queue, "--json", "--config", configPath,
    ]);
    if (workerConsumerExists(parseJson(listed.stdout, "Wrangler Queue consumer list"), workerName)) continue;
    const args = ["exec", "wrangler", "queues", "consumer", "worker", "add", queue, workerName, "--config", configPath];
    appendNumberFlag(args, "--batch-size", optionalNumber(consumer, "max_batch_size"));
    appendNumberFlag(args, "--batch-timeout", optionalNumber(consumer, "max_batch_timeout"));
    appendNumberFlag(args, "--message-retries", optionalNumber(consumer, "max_retries"));
    appendNumberFlag(args, "--max-concurrency", optionalNumber(consumer, "max_concurrency"));
    appendNumberFlag(args, "--retry-delay-secs", optionalNumber(consumer, "retry_delay"));
    const deadLetterQueue = consumer["dead_letter_queue"];
    if (typeof deadLetterQueue === "string" && deadLetterQueue.length > 0) args.push("--dead-letter-queue", deadLetterQueue);
    await requirePnpm(args);
  }
}

function deploymentSummary(bookmark: string, versionId?: string): string {
  return [
    "### Renewlet Cloudflare deployment state",
    "",
    `D1 checkpoint: \`${bookmark}\``,
    `Previous Worker version: ${versionId ? `\`${versionId}\`` : "none (first install)"}`,
    "",
  ].join("\n");
}

function createOperations(options: DeployOptions): DeploymentOperations {
  const environment = { ...process.env, CI_WRANGLER_CONFIG: options.configPath };
  const d1 = createD1OperationsClient({ target: "remote", configPath: options.configPath });

  const readActiveDeployment = async (): Promise<ActiveDeployment | undefined> => {
    const result = await runPnpm(["exec", "wrangler", "deployments", "status", "--json", "--config", options.configPath]);
    if (result.status !== 0) {
      const output = `${result.stderr}\n${result.stdout}`;
      if (/has no deployments|script[_ -]?not[_ -]?found|worker.+not found/i.test(output)) return undefined;
      throw commandFailure("wrangler deployments status", result);
    }
    return parseActiveDeployment(parseJson(result.stdout, "Wrangler deployment status"));
  };

  const readAppliedExclusiveMigrations = async (names: readonly string[]): Promise<Set<string>> => {
    const table = await d1.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'",
      [],
      parseD1NameRow,
    );
    if (table.length === 0 || names.length === 0) return new Set<string>();
    const placeholders = names.map(() => "?").join(", ");
    const rows = await d1.query(
      `SELECT name FROM d1_migrations WHERE name IN (${placeholders})`,
      names,
      parseD1NameRow,
    );
    return new Set(rows);
  };

  const deploy = async (configPath: string, message: string): Promise<ActiveDeployment> => {
    await requirePnpm(["exec", "wrangler", "deploy", "--message", message, "--config", configPath]);
    const active = await readActiveDeployment();
    if (active === undefined) throw new Error("Worker deploy completed without an active deployment");
    return active;
  };

  return {
    async prepare() {
      await requirePnpm(["exec", "node", "scripts/prepare-cloudflare-local-headers.mjs", "--check-production"]);
      const normal = readWranglerConfig(options.configPath);
      writeWranglerConfig(options.maintenanceConfigPath, createMaintenanceWranglerConfig(normal));
    },
    async ensureQueues() {
      await requirePnpm(["cloudflare:queues:ensure"], environment);
    },
    readActiveDeployment,
    readAppliedExclusiveMigrations,
    async captureBookmark() {
      return await captureBookmark(options.configPath);
    },
    async deployMaintenance() {
      return await deploy(options.maintenanceConfigPath, "Renewlet exclusive migration maintenance mode");
    },
    async waitForBackgroundDrain() {
      console.log("Waiting 15 minutes for in-flight Cron and Queue invocations to drain.");
      await sleep(drainWindowMs);
    },
    async applyMigrations() {
      await requirePnpm(["cloudflare:migrations:apply", "--config", options.configPath], environment);
    },
    async verifyDatabase(names) {
      const applied = await readAppliedExclusiveMigrations(names);
      if (names.some((name) => !applied.has(name))) throw new Error("Cloudflare D1 exclusive migration marker is missing");
      const invalid = await d1.query(
        `SELECT COUNT(*) AS count FROM settings WHERE CASE
          WHEN json_valid(settings_json) = 0 THEN 1
          WHEN json_type(settings_json) IS NOT 'object' THEN 1
          WHEN EXISTS (SELECT 1 FROM json_each(settings_json) GROUP BY key HAVING COUNT(*) > 1) THEN 1
          WHEN json_type(settings_json, '$.locale') IS NOT NULL THEN 1
          WHEN json_type(settings_json, '$.localePreference') IS NOT 'text' THEN 1
          WHEN json_extract(settings_json, '$.localePreference') NOT IN ('auto', 'zh-CN', 'en-US') THEN 1
          ELSE 0 END = 1`,
        [],
        parseD1CountRow,
      );
      if (invalid.at(0) !== 0) throw new Error("Cloudflare D1 settings locale invariant failed");
      const expectedTriggers = exclusiveMigrationTriggerDefinitions(names);
      if (expectedTriggers.size > 0) {
        const placeholders = [...expectedTriggers].map(() => "?").join(", ");
        const guards = await d1.query(
          `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${placeholders}) ORDER BY name`,
          [...expectedTriggers.keys()],
          parseD1TriggerRow,
        );
        // marker 只证明 migration 跑过；完整定义比较才能阻止同名 trigger 被手工弱化后继续部署。
        assertD1TriggerDefinitions(expectedTriggers, guards);
      }
    },
    async deployNormal() {
      return await deploy(options.configPath, "Renewlet normal service");
    },
    async restoreWorker(versionId) {
      await requirePnpm([
        "exec", "wrangler", "rollback", versionId, "--yes", "--message", "Restore Renewlet before exclusive D1 migration", "--config", options.configPath,
      ]);
      await requirePnpm(["exec", "wrangler", "triggers", "deploy", "--config", options.configPath]);
      await restoreQueueConsumers(options.configPath);
      const active = await readActiveDeployment();
      if (active?.versionId !== versionId) throw new Error("Previous Worker version was not restored");
    },
    async restoreDatabase(bookmark) {
      await requirePnpm([
        "exec", "wrangler", "d1", "time-travel", "restore", "DB", `--bookmark=${validateBookmark(bookmark)}`, "--config", options.configPath,
      ]);
    },
    recordCheckpoint(bookmark, versionId) {
      const outputPath = process.env["GITHUB_OUTPUT"];
      const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
      if (outputPath && summaryPath) {
        const checkpointOptions = {
          configPath: options.configPath,
          maintenanceConfigPath: options.maintenanceConfigPath,
          ...(versionId === undefined ? {} : { workerVersion: versionId }),
        };
        writeDeploymentCheckpointEvidence(bookmark, outputPath, summaryPath, checkpointOptions);
      } else {
        console.log(deploymentSummary(bookmark, versionId));
      }
    },
    recordRecoveryHint(bookmark, versionId) {
      const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
      const recoveryOptions = {
        configPath: options.configPath,
        maintenanceConfigPath: options.maintenanceConfigPath,
        workerVersion: versionId,
      };
      if (summaryPath) writeDeploymentRecoveryHint(bookmark, summaryPath, recoveryOptions);
      console.error(`D1 recovery must precede Worker rollback: ${deploymentRecoveryCommand(bookmark, recoveryOptions)}`);
    },
  };
}

type CliOptions = ({ mode: "deploy" } & DeployOptions) | ({ mode: "recover" } & RecoveryOptions);

function safeWorkerVersion(value: string): string {
  if (!/^[A-Za-z0-9-]{10,128}$/.test(value)) throw new Error("--worker-version is invalid");
  return value;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let index = 0;
  let mode: "deploy" | "recover" = "deploy";
  if (argv[0] === "deploy" || argv[0] === "recover") {
    mode = argv[0];
    index = 1;
  }
  let configPath = "wrangler.jsonc";
  let maintenanceConfigPath: string | undefined;
  let bookmark: string | undefined;
  let workerVersion: string | undefined;
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!["--config", "--maintenance-config", "--bookmark", "--worker-version"].includes(argument ?? "") || !value) {
      throw new Error("Usage: cloudflare-deploy.ts [deploy | recover] [--config <path>] [--maintenance-config <path>] [--bookmark <bookmark> --worker-version <id>]");
    }
    if (argument === "--config") configPath = value;
    else if (argument === "--maintenance-config") maintenanceConfigPath = value;
    else if (argument === "--bookmark") bookmark = validateBookmark(value);
    else workerVersion = safeWorkerVersion(value);
    index += 1;
  }
  const resolvedConfig = resolve(repoRoot, configPath);
  const resolvedMaintenance = resolve(repoRoot, maintenanceConfigPath ?? "wrangler.maintenance.generated.jsonc");
  if (resolvedConfig === resolvedMaintenance) throw new Error("Normal and maintenance Wrangler configs must use different paths");
  if (mode === "deploy") return { mode, configPath: resolvedConfig, maintenanceConfigPath: resolvedMaintenance };
  if (!bookmark || !workerVersion) throw new Error("recover requires --bookmark and --worker-version");
  return { mode, configPath: resolvedConfig, maintenanceConfigPath: resolvedMaintenance, bookmark, workerVersion };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const operations = createOperations(options);
  if (options.mode === "recover") {
    await runCloudflareRecovery(operations, options);
    return;
  }
  await runCloudflareDeployment(operations, exclusiveMigrationNames());
}

const entryPath = process.argv[1];
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
