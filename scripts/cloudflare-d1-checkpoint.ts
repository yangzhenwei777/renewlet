import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: readonly string[]) => Promise<CommandResult>;

export interface DeploymentCheckpointOptions {
  configPath: string;
  maintenanceConfigPath: string;
  workerVersion?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 限制 bookmark 为单行可打印 token，防止远端 JSON 污染 Actions output 或人工恢复命令。 */
export function validateBookmark(value: unknown): string {
  if (typeof value !== "string") throw new Error("Wrangler Time Travel JSON is missing bookmark");
  const bookmark = value.trim();
  if (bookmark.length === 0 || bookmark !== value || bookmark.length > 512 || /[\u0000-\u0020\u007f`]/.test(bookmark)) {
    throw new Error("Wrangler Time Travel JSON contains an invalid bookmark");
  }
  return bookmark;
}

export function parseBookmarkJson(stdout: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error("Wrangler Time Travel returned invalid JSON");
  }
  if (!isRecord(payload)) {
    throw new Error("Wrangler Time Travel returned an invalid JSON object");
  }
  if (!("bookmark" in payload)) throw new Error("Wrangler Time Travel JSON is missing bookmark");
  if (Object.keys(payload).length !== 1) throw new Error("Wrangler Time Travel returned an invalid JSON object");
  return validateBookmark(payload["bookmark"]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function deploymentRecoveryCommand(
  bookmark: string,
  options: DeploymentCheckpointOptions & { workerVersion: string },
): string {
  return [
    "pnpm cloudflare:deploy:recover --",
    `--config ${shellQuote(options.configPath)}`,
    `--maintenance-config ${shellQuote(options.maintenanceConfigPath)}`,
    `--bookmark ${shellQuote(validateBookmark(bookmark))}`,
    `--worker-version ${shellQuote(options.workerVersion)}`,
  ].join(" ");
}

function checkpointSummary(bookmark: string, options: DeploymentCheckpointOptions): string {
  const lines = [
    "### Renewlet Cloudflare deployment checkpoint",
    "",
    `D1 checkpoint: \`${bookmark}\``,
    `Previous Worker version: ${options.workerVersion ? `\`${options.workerVersion}\`` : "none (first install)"}`,
  ];
  if (options.workerVersion) {
    lines.push(
      "",
      "Recovery is destructive. Review writes made after the checkpoint, then use the maintenance-first orchestrator:",
      "",
      `\`${deploymentRecoveryCommand(bookmark, { ...options, workerVersion: options.workerVersion })}\``,
    );
  }
  return [...lines, "", ""].join("\n");
}

function recoverySummary(
  bookmark: string,
  options: DeploymentCheckpointOptions & { workerVersion: string },
): string {
  return [
    "### Renewlet Cloudflare recovery review required",
    "",
    "A failure after the first D1 write left Renewlet in maintenance mode. The database is not restored automatically because Time Travel overwrites in-place writes.",
    "",
    `D1 checkpoint: \`${bookmark}\``,
    `Previous Worker version: \`${options.workerVersion}\``,
    "",
    "Review post-checkpoint writes, then restore D1 before the previous Worker with:",
    "",
    `\`${deploymentRecoveryCommand(bookmark, options)}\``,
    "",
  ].join("\n");
}

export function writeDeploymentCheckpointEvidence(
  bookmark: string,
  githubOutputPath: string,
  githubSummaryPath: string,
  options: DeploymentCheckpointOptions,
): void {
  const checked = validateBookmark(bookmark);
  appendFileSync(githubOutputPath, `bookmark=${checked}\n`, "utf8");
  if (options.workerVersion) appendFileSync(githubOutputPath, `worker-version=${options.workerVersion}\n`, "utf8");
  appendFileSync(githubSummaryPath, checkpointSummary(checked, options), "utf8");
}

export function writeDeploymentRecoveryHint(
  bookmark: string,
  githubSummaryPath: string,
  options: DeploymentCheckpointOptions & { workerVersion: string },
): void {
  appendFileSync(githubSummaryPath, recoverySummary(validateBookmark(bookmark), options), "utf8");
}

async function runPnpm(args: readonly string[]): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("pnpm", [...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", () => reject(new Error("Unable to start Wrangler Time Travel checkpoint")));
    child.on("close", (status: number | null) => resolvePromise({ status, stdout, stderr }));
  });
}

export async function captureBookmark(
  configPath: string | undefined,
  runner: CommandRunner = runPnpm,
): Promise<string> {
  const args = ["exec", "wrangler", "d1", "time-travel", "info", "DB", "--json"];
  if (configPath !== undefined) args.push("--config", configPath);
  const result = await runner(args);
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(detail.length > 0
      ? `Wrangler Time Travel checkpoint failed: ${detail}`
      : "Wrangler Time Travel checkpoint failed");
  }
  return parseBookmarkJson(result.stdout);
}
