import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindLocalD1Parameters,
  D1RemoteClient,
  parseD1QueryResults,
  type D1Client,
  type D1QueryResult,
  type D1RowParser,
  type D1Statement,
  type D1Value,
} from "./cloudflare-d1-client";
import { readWranglerConfig } from "./cloudflare-wrangler-config";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 运维脚本必须显式选择 local/remote，禁止根据凭据存在与否猜测写入目标。 */
export interface D1TargetOptions {
  configPath?: string;
  target: "local" | "remote";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveDatabaseId(options: D1TargetOptions): string {
  const environmentId = process.env["D1_DATABASE_ID"]?.trim();
  if (environmentId) return environmentId;
  const configPath = resolve(repoRoot, options.configPath ?? "wrangler.jsonc");
  const config = readWranglerConfig(configPath);
  const bindings = isRecord(config) && Array.isArray(config["d1_databases"])
    ? config["d1_databases"]
    : [];
  for (const binding of bindings) {
    if (!isRecord(binding) || binding["binding"] !== "DB" || typeof binding["database_id"] !== "string") continue;
    const databaseId = binding["database_id"].trim();
    if (databaseId && databaseId !== "00000000-0000-0000-0000-000000000000") return databaseId;
  }
  throw new Error("D1_DATABASE_ID or a generated Wrangler config with the DB binding is required");
}

function parseWranglerResults(stdout: string, expectedCount: number): D1QueryResult[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error("Local D1 query returned invalid Wrangler JSON");
  }
  return parseD1QueryResults(payload, expectedCount, "Local D1 query");
}

/** local 迁移演练与 remote 运维脚本共用同一最小客户端，避免保护和回填状态机分叉。 */
export class D1LocalClient implements D1Client {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly configPath?: string) {}

  async query<T>(sql: string, params: readonly D1Value[], parseRow: D1RowParser<T>): Promise<T[]> {
    const results = await this.batch([{ sql, params }]);
    const result = results.at(0);
    if (result === undefined) throw new Error("Local D1 query returned no result");
    return result.results.map(parseRow);
  }

  async batch(queries: readonly D1Statement[]): Promise<D1QueryResult[]> {
    if (queries.length === 0) return [];
    // 每次 local 调用都会启动独立 Wrangler/Miniflare 进程；并发只读也会争用同一 SQLite 状态并触发 internal error。
    // 上层仍可 Promise.all 探测远端，local transport 在进程边界排队，且失败不会阻塞后续可重放操作。
    const execute = async (): Promise<D1QueryResult[]> => {
      // Wrangler local 没有参数绑定入口且进程可能在多语句中途退出；语句必须可重放，参数只编码为类型化 SQLite literal。
      const command = queries
        .map((query) => bindLocalD1Parameters(query.sql, query.params ?? []).replace(/;\s*$/, ""))
        .join(";\n");
      const args = ["exec", "wrangler", "d1", "execute", "DB", "--local", "--command", command, "--json"];
      if (this.configPath) args.push("--config", this.configPath);
      const stdout = await new Promise<string>((resolvePromise, reject) => {
        const child = spawn("pnpm", args, {
          cwd: repoRoot,
          env: { ...process.env, CI: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { output += chunk; });
        child.stderr.resume();
        child.on("error", () => reject(new Error("Unable to start Wrangler for local D1 operation")));
        child.on("close", (status: number | null) => {
          if (status === 0) resolvePromise(output);
          else reject(new Error("Local D1 operation failed"));
        });
      });
      return parseWranglerResults(stdout, queries.length);
    };
    const result = this.operationTail.then(execute, execute);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** 只为显式目标创建 transport；remote 凭据不会参与 local 演练，避免环境变量把本地检查变成生产写入。 */
export function createD1OperationsClient(options: D1TargetOptions): D1Client {
  if (options.target === "local") return new D1LocalClient(options.configPath);
  const apiToken = process.env["CLOUDFLARE_API_TOKEN"]?.trim();
  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"]?.trim();
  if (!apiToken || !accountId) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
  return new D1RemoteClient(accountId, resolveDatabaseId(options), apiToken);
}
