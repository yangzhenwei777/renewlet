import { md5 } from "@noble/hashes/legacy.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { XMLParser } from "fast-xml-parser";
import { sendUpstreamRequest } from "./upstream-http";

const WEBDAV_DIRECTORY_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const textEncoder = new TextEncoder();
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

type DigestState = {
  algorithm: "MD5" | "MD5-SESS";
  cnonce: string;
  nc: number;
  nonce: string;
  opaque?: string;
  qop: "auth" | null;
  realm: string;
};

type WorkerWebDAVOptions = {
  baseURL: string;
  password: string;
  timeoutMs: number;
  username: string;
};

export class WorkerWebDAVRequestError extends Error {
  constructor(readonly response: Response) {
    super(`WebDAV HTTP ${response.status}`);
    this.name = "WorkerWebDAVRequestError";
  }
}

/** Worker 原生 WebDAV 协议边界；业务层只接触相对路径和字节，不接触认证、XML 或 HTTP 状态。 */
export class WorkerWebDAVClient {
  readonly #baseURL: string;
  readonly #password: string;
  readonly #timeoutMs: number;
  readonly #username: string;
  #digest: DigestState | null = null;

  constructor(options: WorkerWebDAVOptions) {
    this.#baseURL = options.baseURL.replace(/\/+$/, "");
    this.#password = options.password;
    this.#timeoutMs = options.timeoutMs;
    this.#username = options.username;
  }

  async ensureDirectory(path: string): Promise<void> {
    const segments = webDAVPathSegments(path);
    for (let index = 1; index <= segments.length; index += 1) {
      const currentPath = segments.slice(0, index).join("/");
      const probe = await this.#request(currentPath, {
        method: "PROPFIND",
        headers: { Accept: "application/xml", Depth: "0" },
      });
      if (probe.status !== 404) {
        await requireWebDAVStatus(probe, [200, 207]);
        continue;
      }
      await cancelResponseBody(probe);
      const created = await this.#request(currentPath, { method: "MKCOL" });
      if (created.status === 405) {
        // 并发请求可能已创建同一目录；只接受随后可 PROPFIND 的目标，不能把任意 405 当成功。
        await cancelResponseBody(created);
        const verified = await this.#request(currentPath, {
          method: "PROPFIND",
          headers: { Accept: "application/xml", Depth: "0" },
        });
        await requireWebDAVStatus(verified, [200, 207]);
        continue;
      }
      await requireWebDAVStatus(created, [200, 201, 204]);
    }
  }

  async list(path: string): Promise<string[]> {
    const response = await this.#request(path, {
      method: "PROPFIND",
      headers: {
        Accept: "application/xml",
        "Content-Type": "application/xml; charset=utf-8",
        Depth: "1",
      },
      body: "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>",
    });
    await requireWebDAVStatus(response, [200, 207], false);
    const xml = new TextDecoder().decode(await readResponseBytes(response, WEBDAV_DIRECTORY_RESPONSE_MAX_BYTES));
    return webDAVResponseBasenames(xml);
  }

  async put(path: string, content: Uint8Array, contentType: string): Promise<void> {
    const response = await this.#request(path, {
      method: "PUT",
      headers: {
        "Content-Length": String(content.byteLength),
        "Content-Type": contentType,
      },
      body: content.slice(),
    });
    await requireWebDAVStatus(response, [200, 201, 204]);
  }

  async get(path: string, limitBytes: number): Promise<Uint8Array> {
    const response = await this.#request(path, { method: "GET" });
    await requireWebDAVStatus(response, [200], false);
    return await readResponseBytes(response, limitBytes);
  }

  async delete(path: string): Promise<void> {
    const response = await this.#request(path, { method: "DELETE" });
    await requireWebDAVStatus(response, [200, 204]);
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const url = webDAVRequestURL(this.#baseURL, path);
    let response = await this.#requestOnce(url, init);
    if (response.status !== 401) return response;
    const challenge = digestStateFromResponse(response);
    if (!challenge) return response;

    // Auto 认证先覆盖常见 Basic；只有服务端明确挑战 Digest 时才释放首个 401 body 并重放一次同一请求。
    await cancelResponseBody(response);
    this.#digest = challenge;
    response = await this.#requestOnce(url, init);
    return response;
  }

  async #requestOnce(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    const authorization = this.#digest
      ? digestAuthorization(this.#digest, this.#username, this.#password, init.method ?? "GET", new URL(url))
      : basicAuthorization(this.#username, this.#password);
    if (authorization) headers.set("Authorization", authorization);
    return await sendUpstreamRequest(url, { ...init, headers }, {
      provider: "WebDAV",
      timeoutMs: this.#timeoutMs,
      secrets: [this.#password],
    });
  }
}

async function requireWebDAVStatus(response: Response, allowed: readonly number[], cancelBody = true): Promise<void> {
  if (!allowed.includes(response.status)) throw new WorkerWebDAVRequestError(response);
  if (cancelBody) await cancelResponseBody(response);
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body) await response.body.cancel().catch(() => undefined);
}

async function readResponseBytes(response: Response, limitBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    await cancelResponseBody(response);
    throw new Error("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function basicAuthorization(username: string, password: string): string | null {
  if (!username || !password) return null;
  const bytes = textEncoder.encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function digestStateFromResponse(response: Response): DigestState | null {
  const header = response.headers.get("www-authenticate") ?? "";
  if (!/^\s*Digest\s/i.test(header)) return null;
  const values: Record<string, string> = {};
  const pattern = /([a-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/gi;
  for (let match = pattern.exec(header); match; match = pattern.exec(header)) {
    const key = match[1]?.toLowerCase();
    const value = match[2] ?? match[3];
    if (key && value !== undefined) values[key] = value;
  }
  const realm = values["realm"];
  const nonce = values["nonce"];
  const algorithm = (values["algorithm"] ?? "MD5").toUpperCase();
  if (!realm || !nonce || (algorithm !== "MD5" && algorithm !== "MD5-SESS")) return null;
  const qopValues = (values["qop"] ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (qopValues.length > 0 && !qopValues.includes("auth")) return null;
  return {
    algorithm,
    cnonce: randomHex(16),
    nc: 0,
    nonce,
    ...(values["opaque"] ? { opaque: values["opaque"] } : {}),
    qop: qopValues.includes("auth") ? "auth" : null,
    realm,
  };
}

function digestAuthorization(state: DigestState, username: string, password: string, method: string, url: URL): string {
  state.nc += 1;
  const nc = state.nc.toString(16).padStart(8, "0");
  const uri = `${url.pathname}${url.search}`;
  const initialHA1 = md5Hex(`${username}:${state.realm}:${password}`);
  const ha1 = state.algorithm === "MD5-SESS" ? md5Hex(`${initialHA1}:${state.nonce}:${state.cnonce}`) : initialHA1;
  const ha2 = md5Hex(`${method.toUpperCase()}:${uri}`);
  const response = state.qop
    ? md5Hex(`${ha1}:${state.nonce}:${nc}:${state.cnonce}:${state.qop}:${ha2}`)
    : md5Hex(`${ha1}:${state.nonce}:${ha2}`);
  const values = [
    `username="${escapeDigestValue(username)}"`,
    `realm="${escapeDigestValue(state.realm)}"`,
    `nonce="${escapeDigestValue(state.nonce)}"`,
    `uri="${escapeDigestValue(uri)}"`,
    `response="${response}"`,
    `algorithm=${state.algorithm}`,
  ];
  if (state.opaque) values.push(`opaque="${escapeDigestValue(state.opaque)}"`);
  if (state.qop) values.push(`qop=${state.qop}`, `nc=${nc}`, `cnonce="${state.cnonce}"`);
  return `Digest ${values.join(", ")}`;
}

function md5Hex(value: string): string {
  return bytesToHex(md5(utf8ToBytes(value)));
}

function escapeDigestValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function webDAVRequestURL(baseURL: string, path: string): string {
  const encodedPath = webDAVPathSegments(path).map((segment) => encodeURIComponent(segment)).join("/");
  return encodedPath ? `${baseURL}/${encodedPath}` : `${baseURL}/`;
}

function webDAVPathSegments(path: string): string[] {
  return path.split("/").map((segment) => segment.trim()).filter(Boolean);
}

function webDAVResponseBasenames(xml: string): string[] {
  const parsed: unknown = xmlParser.parse(xml);
  const root = objectProperty(parsed, "multistatus");
  const responses = arrayValue(objectProperty(root, "response"));
  const basenames: string[] = [];
  for (const response of responses) {
    const href = stringValue(objectProperty(response, "href"));
    if (!href) continue;
    const basename = decodedWebDAVBasename(href);
    if (basename) basenames.push(basename);
  }
  return basenames;
}

function decodedWebDAVBasename(href: string): string {
  const pathname = (() => {
    try {
      return new URL(href, "https://webdav.invalid").pathname;
    } catch {
      return href;
    }
  })();
  const encoded = pathname.split("/").filter(Boolean).at(-1) ?? "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function objectProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.entries(value).find(([entryKey]) => entryKey === key)?.[1];
}

function arrayValue(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const text = objectProperty(value, "#text");
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return Array.from(value, (item) => item.toString(16).padStart(2, "0")).join("");
}
