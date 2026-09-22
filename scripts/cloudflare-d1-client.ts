import { setTimeout as sleep } from "node:timers/promises";

/** D1 REST 与本地 Wrangler 适配器共享的 SQLite 标量；布尔值必须由调用方显式编码为 0/1。 */
export type D1Value = string | number | null;

/** 保留 SQL 与参数的结构化边界，避免远端请求、日志或 shell 拼接提前展开账本数据。 */
export interface D1Statement {
  sql: string;
  params?: readonly D1Value[];
}

/** 已通过 envelope、语句数量和逐项 success 校验的 D1 结果。 */
export interface D1QueryResult {
  success: true;
  results: unknown[];
}

/** 行解析器是 D1 不可信 JSON 进入业务类型前的唯一验证边界。 */
export type D1RowParser<T> = (value: unknown) => T;

/** backfill 的 local/remote 运行面共用此最小接口，保证状态机不分叉。 */
export interface D1Client {
  /** 每一行都必须经调用方 parser 验证；transport 不把 unknown JSON 伪装成业务类型。 */
  query<T>(sql: string, params: readonly D1Value[], parseRow: D1RowParser<T>): Promise<T[]>;
  /** 空批次不发请求；非空批次保持顺序和结果基数，调用方仍须保证中断或响应丢失后可整批重放。 */
  batch(statements: readonly D1Statement[]): Promise<D1QueryResult[]>;
}

/** 远端 transport 的有界重试配置；可替换依赖仅用于确定性协议测试。 */
export interface D1RemoteClientOptions {
  fetch?: typeof fetch;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  random?: () => number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function normalizeStatement(statement: D1Statement): D1Statement {
  if (statement.sql.trim().length === 0) {
    throw new Error("Cloudflare D1 statement SQL must not be empty");
  }
  const params = statement.params ?? [];
  for (const value of params) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Cloudflare D1 statement parameters must be finite JSON values");
    }
  }
  return params.length === 0
    ? { sql: statement.sql }
    : { sql: statement.sql, params: [...params] };
}

function localD1Literal(value: D1Value): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (Number.isFinite(value)) return String(value);
  throw new Error("Local D1 statement parameters must be finite values");
}

function localD1ParameterAt(params: readonly D1Value[], index: number): D1Value {
  const value = params.at(index);
  if (value === undefined) {
    throw new Error("Local D1 query has fewer parameters than placeholders");
  }
  return value;
}

/**
 * 为 Wrangler local CLI 编码匿名占位符，并严格拒绝占位符与参数数量漂移。
 * SQL 字面量、引用标识符和注释中的问号保持原样，避免测试路径改变真实查询语义。
 */
export function bindLocalD1Parameters(sql: string, params: readonly D1Value[]): string {
  let output = "";
  let parameterIndex = 0;
  let quote: "'" | '"' | "`" | null = null;
  let bracketIdentifier = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql.charAt(index);
    const next = sql.charAt(index + 1);
    if (lineComment) {
      output += character;
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      output += character;
      if (character === "*" && next === "/") {
        output += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (bracketIdentifier) {
      output += character;
      if (character === "]") bracketIdentifier = false;
      continue;
    }
    if (quote) {
      output += character;
      if (character === quote) {
        if (next === quote) {
          output += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "-" && next === "-") {
      output += character + next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (character === "/" && next === "*") {
      output += character + next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (character === "[") {
      bracketIdentifier = true;
      output += character;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      output += character;
      continue;
    }
    if (character === "?") {
      if (/\d/.test(next)) {
        throw new Error("Local D1 query only supports anonymous question-mark placeholders");
      }
      output += localD1Literal(localD1ParameterAt(params, parameterIndex));
      parameterIndex += 1;
      continue;
    }
    output += character;
  }

  if (parameterIndex !== params.length) {
    throw new Error("Local D1 query has more parameters than placeholders");
  }
  return output;
}

/** 校验 D1/Wrangler JSON 的结果基数与顺序，防止 batch 响应漂移后写错调用方语句。 */
export function parseD1QueryResults(payload: unknown, expectedCount: number, source: string): D1QueryResult[] {
  const entries: unknown[] = isUnknownArray(payload) ? payload : [payload];
  if (entries.length !== expectedCount) {
    throw new Error(`${source} returned an unexpected result count`);
  }
  return entries.map((entry) => {
    if (!isRecord(entry) || entry["success"] !== true || !isUnknownArray(entry["results"])) {
      throw new Error(`${source} returned an unsuccessful result`);
    }
    return {
      success: true,
      results: entry["results"],
    };
  });
}

function cloudflareFailures(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload)) return [];
  const failures = isUnknownArray(payload["errors"])
    ? payload["errors"].filter(isRecord)
    : [];
  const rawResults = payload["result"];
  const results = rawResults === undefined
    ? []
    : isUnknownArray(rawResults)
      ? rawResults
      : [rawResults];
  for (const result of results) {
    if (!isRecord(result) || result["success"] === true) continue;
    failures.push(result);
    if (isUnknownArray(result["errors"])) failures.push(...result["errors"].filter(isRecord));
  }
  return failures;
}

function cloudflareErrorCode(entry: Record<string, unknown>): number | undefined {
  const rawCode = entry["code"];
  const code = typeof rawCode === "number"
    ? rawCode
    : typeof rawCode === "string" && /^\d+$/.test(rawCode)
      ? Number(rawCode)
      : Number.NaN;
  return Number.isSafeInteger(code) && code >= 0 ? code : undefined;
}

function cloudflareFailureMessage(entry: Record<string, unknown>): string {
  if (typeof entry["message"] === "string") return entry["message"];
  return typeof entry["error"] === "string" ? entry["error"] : "";
}

function safeCloudflareFailureDetail(payload: unknown, status?: number): string {
  // D1 message 可能包含原 SQL；跨进程错误只保留 HTTP 状态和数字 code，避免账本字段或参数进入 CI 日志。
  const codes = [...new Set(cloudflareFailures(payload).flatMap((entry) => {
    const code = cloudflareErrorCode(entry);
    return code === undefined ? [] : [code];
  }))];
  const statusDetail = status === undefined ? "" : ` (HTTP ${status})`;
  const codeDetail = codes.length === 0 ? "" : ` [code ${codes.join(", ")}]`;
  return `${statusDetail}${codeDetail}`;
}

function hasRetryableCloudflareError(payload: unknown): boolean {
  // D1 可能以 HTTP 200 返回 7429/reset；这里只识别平台瞬时失败，SQL、权限和协议错误必须立即终止。
  return cloudflareFailures(payload).some((entry) => {
    const message = cloudflareFailureMessage(entry);
    return cloudflareErrorCode(entry) === 7429
      || /storage (?:operation )?(?:which )?caused object to be reset/i.test(message)
      || /D1 DB storage operation exceeded timeout/i.test(message)
      || /Network connection lost/i.test(message);
  });
}

function parseJsonPayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Cloudflare D1 query returned invalid JSON");
  }
}

function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  // Retry-After 同时允许秒数与 HTTP-date；统一成毫秒后再受本客户端退避上限约束。
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - nowMs);
}

class RetryableD1RequestError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RetryableD1RequestError";
    this.retryAfterMs = retryAfterMs;
  }
}

function isRetryableFetchFailure(error: unknown): boolean {
  // fetch 的网络失败没有稳定子类；只接受平台超时/重置和常见底层网络信号，业务异常绝不进入重试。
  if (error instanceof RetryableD1RequestError) return true;
  const name = isRecord(error) && typeof error["name"] === "string" ? error["name"] : "";
  const message = isRecord(error) && typeof error["message"] === "string" ? error["message"] : "";
  return name === "AbortError"
    || name === "TimeoutError"
    || error instanceof TypeError
    || /fetch failed|network|socket|ECONNRESET|ETIMEDOUT/i.test(message);
}

function retryFailureMessage(error: unknown): string {
  if (error instanceof RetryableD1RequestError) return error.message;
  return "Cloudflare D1 network request failed";
}

/**
 * D1 Query REST transport，只对瞬时网络/平台失败做有限重试。
 * 调用方只能提交幂等查询、键级写入或整批重放仍收敛的状态机 DDL，避免响应丢失后重复副作用。
 */
export class D1RemoteClient implements D1Client {
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(
    private readonly accountId: string,
    private readonly databaseId: string,
    private readonly apiToken: string,
    options: D1RemoteClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxAttempts = requirePositiveInteger("maxAttempts", options.maxAttempts ?? 5);
    // 与 D1 单查询 30 秒平台上限对齐，避免客户端在平台已经终止后继续悬挂等待。
    this.requestTimeoutMs = requirePositiveInteger("requestTimeoutMs", options.requestTimeoutMs ?? 30_000);
    this.retryBaseDelayMs = requireNonNegativeInteger("retryBaseDelayMs", options.retryBaseDelayMs ?? 1_000);
    this.retryMaxDelayMs = requireNonNegativeInteger("retryMaxDelayMs", options.retryMaxDelayMs ?? 15_000);
    if (this.retryMaxDelayMs < this.retryBaseDelayMs) {
      throw new Error("retryMaxDelayMs must be greater than or equal to retryBaseDelayMs");
    }
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (async (delayMs): Promise<void> => sleep(delayMs));
  }

  async query<T>(sql: string, params: readonly D1Value[], parseRow: D1RowParser<T>): Promise<T[]> {
    const results = await this.batch([{ sql, params }]);
    const result = results.at(0);
    if (result === undefined) throw new Error("Cloudflare D1 query returned no result");
    return result.results.map(parseRow);
  }

  async batch(statements: readonly D1Statement[]): Promise<D1QueryResult[]> {
    if (statements.length === 0) return [];
    const normalized = statements.map(normalizeStatement);

    // 远端可能在提交后丢失响应；调用方必须保证整个批次重放后收敛到同一持久状态。
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.request(normalized);
      } catch (error: unknown) {
        if (!isRetryableFetchFailure(error)) throw error;
        const message = retryFailureMessage(error);
        if (attempt >= this.maxAttempts) {
          throw new Error(`${message} after ${attempt} attempts`);
        }
        const retryAfterMs = error instanceof RetryableD1RequestError ? error.retryAfterMs : undefined;
        await this.sleep(this.retryDelayMs(attempt, retryAfterMs));
      }
    }
    throw new Error("Cloudflare D1 query exhausted its retry budget");
  }

  private async request(statements: readonly D1Statement[]): Promise<D1QueryResult[]> {
    const first = statements.at(0);
    if (first === undefined) return [];
    // D1 REST 与 Worker binding 的 batch 不是同一调用形状；多语句必须放在 batch 字段中才能获得服务端原子批次语义。
    const body = statements.length === 1 ? first : { batch: statements };
    const response = await this.fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/d1/database/${encodeURIComponent(this.databaseId)}/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      },
    );

    const responseText = await response.text();
    let payload: unknown;
    try {
      payload = parseJsonPayload(responseText);
    } catch (error: unknown) {
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableD1RequestError(
          `Cloudflare D1 query failed with HTTP ${response.status}`,
          parseRetryAfterMs(response.headers.get("retry-after"), this.now()),
        );
      }
      throw error;
    }

    // Cloudflare 的错误 message 可能回显 SQL；异常只保留状态和数字 code，分类可读 message 但绝不向日志边界透传。
    const safeDetail = safeCloudflareFailureDetail(payload, response.status);
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableD1RequestError(
          `Cloudflare D1 query failed${safeDetail}`,
          parseRetryAfterMs(response.headers.get("retry-after"), this.now()),
        );
      }
      throw new Error(`Cloudflare D1 query failed${safeDetail}`);
    }
    if (!isRecord(payload) || payload["success"] !== true || payload["result"] === undefined) {
      if (hasRetryableCloudflareError(payload)) {
        throw new RetryableD1RequestError(`Cloudflare D1 query failed${safeDetail}`);
      }
      throw new Error(`Cloudflare D1 query failed${safeDetail}`);
    }
    if (hasRetryableCloudflareError(payload)) {
      throw new RetryableD1RequestError(`Cloudflare D1 query failed${safeDetail}`);
    }

    // Cloudflare API 是不可信边界；结果数量和逐语句 success 都通过后，调用方才能按原 batch 顺序消费 rows。
    return parseD1QueryResults(payload["result"], statements.length, "Cloudflare D1 query");
  }

  private retryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
    // jitter 避免并发部署同步重试；服务端 Retry-After 优先，但仍受有限重试的最大等待约束。
    const exponential = Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * 2 ** (attempt - 1));
    const jittered = Math.min(
      this.retryMaxDelayMs,
      exponential + Math.floor(exponential * 0.25 * Math.max(0, Math.min(1, this.random()))),
    );
    return retryAfterMs === undefined
      ? jittered
      : Math.min(this.retryMaxDelayMs, Math.max(jittered, retryAfterMs));
  }
}
