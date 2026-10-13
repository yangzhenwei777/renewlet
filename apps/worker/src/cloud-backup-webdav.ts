import { AsyncLocalStorage } from "node:async_hooks";
import { AuthType, createClient, getPatcher } from "webdav/web";
import type { WebDAVClient } from "webdav";
import { CLOUD_BACKUP_MAX_SNAPSHOT_BYTES } from "@renewlet/shared/schemas/cloud-backup";

import { CronBudgetExceeded, type CronBudget } from "./cron-budget";
import { fetchUpstream } from "./upstream-http";

// SDK只有模块级传输扩展点；固定注册一次，异步上下文隔离每次操作，禁止按请求替换patcher。
const operationBudget = new AsyncLocalStorage<CronBudget | undefined>();
getPatcher().patch("fetch", (input: unknown, init: unknown) => {
  if (typeof input !== "string") throw new TypeError("WebDAV SDK fetch requires a URL string");
  const options = init as RequestInit;
  const budget = operationBudget.getStore();
  return fetchUpstream(input, options, budget);
});

const CLOUD_BACKUP_UPSTREAM_TIMEOUT_MS = 45_000;

export class WebDAVOperationLimitExceeded extends CronBudgetExceeded {
  constructor() {
    super("external");
    this.name = "WebDAVOperationLimitExceeded";
    this.message = "CLOUD_BACKUP_WEBDAV_REQUEST_LIMIT";
  }
}

type WorkerWebDAVOptions = {
  baseURL: string;
  budget?: CronBudget | undefined;
  password: string;
  timeoutMs?: number;
  username: string;
};

/**
 * WebDAV SDK 错误只在适配层转换为 Renewlet 可诊断的请求上下文；协议认证、XML 和响应状态由 webdav 官方客户端负责。
 */
export class WorkerWebDAVRequestError extends Error {
  constructor(
    readonly response: Response | null,
    readonly operation: string,
    readonly target: string,
    readonly timedOut: boolean,
    readonly cause?: unknown,
  ) {
    super(`${operation} ${target}${timedOut ? " timed out" : " failed"}`);
    this.name = "WorkerWebDAVRequestError";
  }
}

export class WorkerWebDAVClient {
  readonly #baseURL: string;
  readonly #budget: CronBudget | undefined;
  readonly #client: WebDAVClient;
  readonly #timeoutMs: number;

  constructor(options: WorkerWebDAVOptions) {
    this.#budget = options.budget;
    this.#baseURL = options.baseURL.replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? CLOUD_BACKUP_UPSTREAM_TIMEOUT_MS;
    const hasCredentials = Boolean(options.username && options.password);
    this.#client = createClient(this.#baseURL, {
      authType: hasCredentials ? AuthType.Auto : AuthType.None,
      ...(hasCredentials ? { username: options.username, password: options.password } : {}),
    });
  }

  async ensureDirectory(path: string, recursive = true): Promise<void> {
    await this.#run("MKCOL", path, (signal) => this.#client.createDirectory(path, { recursive, signal }));
  }

  async list(path: string): Promise<string[]> {
    const entries = await this.#run("PROPFIND", path, (signal) => this.#client.getDirectoryContents(path, { signal }));
    return entries
      .filter((entry) => entry.type === "file")
      .map((entry) => entry.basename)
      .filter(Boolean);
  }

  async put(path: string, content: Uint8Array, contentType: string): Promise<void> {
    await this.#run("PUT", path, (signal) => this.#client.putFileContents(path, webDavBody(content), {
      contentLength: content.byteLength,
      headers: { "Content-Type": contentType },
      signal,
    }));
  }

  async get(path: string, limitBytes = CLOUD_BACKUP_MAX_SNAPSHOT_BYTES): Promise<Uint8Array> {
    return await this.#run("GET", path, async (signal) => {
      // customRequest 仍由 webdav 负责认证、路径编码和状态码处理；适配层只在业务边界限制响应体，避免下载先被 SDK 整包缓冲。
      const response = await this.#client.customRequest(path, { method: "GET", signal });
      const bytes = await readWebDAVResponseBody(response, limitBytes);
      if (bytes.byteLength > limitBytes) throw new Error("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE");
      return bytes;
    });
  }

  async stat(path: string): Promise<number> {
    const result = await this.#run("PROPFIND", path, (signal) => this.#client.stat(path, { signal }));
    const entry = "data" in result ? result.data : result;
    if (entry.type !== "file" || !Number.isFinite(entry.size) || entry.size < 0) {
      throw new Error("CLOUD_BACKUP_WEBDAV_STAT_INVALID");
    }
    return entry.size;
  }

  async delete(path: string): Promise<void> {
    await this.#run("DELETE", path, (signal) => this.#client.deleteFile(path, { signal }));
  }

  #target(path: string): string {
    try {
      const base = new URL(this.#baseURL);
      const basePath = base.pathname.replace(/\/+$/, "");
      const suffix = path.split("/").map((segment) => segment.trim()).filter(Boolean).join("/");
      return suffix ? `host=${base.host}; path=${basePath}/${suffix}` : `host=${base.host}; path=${basePath}/`;
    } catch {
      return `path=${path.replace(/^\/+/, "")}`;
    }
  }

  async #run<T>(operation: string, path: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const budgetWasUnused = this.#budget !== undefined
      && this.#budget.used.externalRequests + this.#budget.used.externalReserved === 0;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    try {
      return await operationBudget.run(this.#budget, () => action(controller.signal));
    } catch (error) {
      // 用满独占预算仍无法完成的操作不能靠下个tick重试；已有其它操作占额时仅让出本片。
      if (error instanceof CronBudgetExceeded && error.resource === "external" && budgetWasUnused) throw new WebDAVOperationLimitExceeded();
      if (error instanceof CronBudgetExceeded) throw error;
      throw new WorkerWebDAVRequestError(webDAVResponseFromError(error), operation, this.#target(path), timedOut, error);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function webDavBody(content: Uint8Array): ArrayBuffer {
  if (content.byteOffset === 0 && content.byteLength === content.buffer.byteLength && content.buffer instanceof ArrayBuffer) return content.buffer;
  const copy = new ArrayBuffer(content.byteLength);
  new Uint8Array(copy).set(content);
  return copy;
}

function webDAVResponseFromError(error: unknown): Response | null {
  if (!error || typeof error !== "object") return null;
  const response = (error as { response?: unknown }).response;
  return isResponseLike(response) ? response : null;
}

function isResponseLike(value: unknown): value is Response {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as { status?: unknown }).status === "number"
    && typeof (value as { text?: unknown }).text === "function";
}

async function readWebDAVResponseBody(response: unknown, limitBytes: number): Promise<Uint8Array> {
  const record = response && typeof response === "object" ? response as { body?: unknown; headers?: { get(name: string): string | null }; arrayBuffer?: () => Promise<ArrayBuffer> } : null;
  const body = record?.body;
  if (!isReadableStream(body)) {
    const declaredLength = Number(record?.headers?.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > limitBytes) throw new Error("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE");
    if (record?.arrayBuffer) return boundedBytes(new Uint8Array(await record.arrayBuffer()), limitBytes);
    throw new Error("CLOUD_BACKUP_WEBDAV_RESPONSE_BODY_INVALID");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limitBytes + 1 - total;
      if (remaining <= 0) break;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (value.byteLength > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function boundedBytes(bytes: Uint8Array, limitBytes: number): Uint8Array {
  if (bytes.byteLength > limitBytes) throw new Error("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE");
  return bytes;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof value === "object"
    && value !== null
    && "getReader" in value
    && typeof (value as { getReader?: unknown }).getReader === "function";
}
