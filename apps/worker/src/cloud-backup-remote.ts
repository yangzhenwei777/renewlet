import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type DeleteObjectCommandOutput,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
  type PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { RequestChecksumCalculation, ResponseChecksumValidation } from "@aws-sdk/middleware-flexible-checksums";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { HttpRequest, HttpResponse } from "@smithy/protocol-http";
import type { HttpHandlerOptions, RequestHandler, RequestHandlerOutput } from "@smithy/types";
import {
  CLOUD_BACKUP_MAX_SNAPSHOT_BYTES,
  cloudBackupSnapshotManifestSchema,
  type CloudBackupErrorDetails,
  type CloudBackupS3Config,
  type CloudBackupSnapshotManifest,
  type CloudBackupWebDavConfig,
} from "@renewlet/shared/schemas/cloud-backup";
import { UPSTREAM_RAW_RESPONSE_TEXT_CAPTURE_MAX_CHARS } from "@renewlet/shared/schemas/upstream";
import { listS3ObjectsV2ViaSignedFetch, S3ListObjectsError } from "./cloud-backup-s3-list";
import { WorkerWebDAVClient, WorkerWebDAVRequestError } from "./cloud-backup-webdav";
import {
  recordToUpstreamHeaders,
  redactUpstreamSecrets,
  type UpstreamFetchResponse,
  type UpstreamProviderResponse,
  upstreamErrorDetailsFromError,
  upstreamProviderResponseFromFetchResponse,
} from "./upstream-response";
import { upstreamTransportDiagnosticMessage } from "./upstream-http";

/**
 * Worker 云备份远端适配层。
 *
 * WebDAV 与 S3 都在这里统一做探针、manifest 校验、上游响应脱敏和错误 shape 收敛；
 * 调用方只处理 CloudBackupRemoteClient，不直接依赖 webdav/AWS SDK 的异常结构。
 */
const textEncoder = new TextEncoder();
const CLOUD_BACKUP_UPSTREAM_TIMEOUT_MS = 45_000;
type CloudBackupProviderResponse = UpstreamProviderResponse;

/** 远端存储失败的产品化错误；details 只能随当前认证请求返回，不写入 last_error 或备份包。 */
export class CloudBackupRemoteError extends Error {
  constructor(
    readonly code: string,
    readonly details?: CloudBackupErrorDetails,
  ) {
    super(code);
    this.name = "CloudBackupRemoteError";
  }
}

/** 远端备份目标的最小能力集；WebDAV/S3 必须共享 manifest 语义和快照校验入口。 */
export type CloudBackupRemoteClient = {
  test(): Promise<void>;
  list(): Promise<CloudBackupSnapshotManifest[]>;
  upload(filename: string, content: Uint8Array, manifest: CloudBackupSnapshotManifest): Promise<void>;
  download(id: string): Promise<{ content: Uint8Array; manifest: CloudBackupSnapshotManifest }>;
  delete(id: string): Promise<void>;
};

/** WebDAV 适配器通过 Worker 原生 fetch 承接 PROPFIND/MKCOL，并保持与 Docker 端相同的 Basic/Digest 认证能力。 */
export class WebDAVCloudBackupClient implements CloudBackupRemoteClient {
  private readonly client: WorkerWebDAVClient;
  private readonly attemptedHost: string;

  constructor(
    private readonly settings: CloudBackupWebDavConfig,
    private readonly password: string,
  ) {
    this.client = new WorkerWebDAVClient({
      baseURL: settings.url,
      username: settings.username ?? "",
      password,
      timeoutMs: CLOUD_BACKUP_UPSTREAM_TIMEOUT_MS,
    });
    this.attemptedHost = providerHostSummary(settings.url);
  }

  async test(): Promise<void> {
    await this.ensureDirectory();
    const name = `.renewlet-probe-${randomHex(4)}.txt`;
    const content = textEncoder.encode("renewlet-cloud-backup-probe");
    await this.put(name, content, "text/plain");
    try {
      const got = await this.get(name);
      if (!bytesEqual(got, content)) throw new Error("CLOUD_BACKUP_WEBDAV_PROBE_MISMATCH");
    } finally {
      await this.deleteFile(name).catch(() => undefined);
    }
    // 测试连接必须覆盖 PROPFIND 列表权限；只验证写读删会漏掉只允许对象操作的 WebDAV 账号。
    await this.list();
  }

  async list(): Promise<CloudBackupSnapshotManifest[]> {
    await this.ensureDirectory();
    const files = await this.withWebDAVError("CLOUD_BACKUP_WEBDAV_PROPFIND_FAILED", async () => await this.client.list(this.remotePath("")));
    const manifests: CloudBackupSnapshotManifest[] = [];
    for (const filename of files) {
      if (!filename.endsWith(".manifest.json")) continue;
      const manifest = await this.readManifest(filename).catch(() => null);
      if (manifest) manifests.push(manifest);
    }
    return manifests;
  }

  async upload(filename: string, content: Uint8Array, manifest: CloudBackupSnapshotManifest): Promise<void> {
    await this.ensureDirectory();
    await this.put(filename, content, "application/zip");
    await this.put(manifestName(manifest.id), textEncoder.encode(JSON.stringify(manifest, null, 2)), "application/json");
  }

  async download(id: string): Promise<{ content: Uint8Array; manifest: CloudBackupSnapshotManifest }> {
    const manifest = await this.readManifest(manifestName(id));
    return { content: await this.get(manifest.filename), manifest };
  }

  async delete(id: string): Promise<void> {
    await this.deleteFile(`${id}.zip`).catch(() => undefined);
    await this.deleteFile(manifestName(id)).catch(() => undefined);
  }

  private async readManifest(filename: string): Promise<CloudBackupSnapshotManifest> {
    return cloudBackupSnapshotManifestSchema.parse(JSON.parse(textDecoder(await this.get(filename))));
  }

  private async ensureDirectory(): Promise<void> {
    await this.withWebDAVError("CLOUD_BACKUP_WEBDAV_MKCOL_FAILED", async () => await this.client.ensureDirectory(this.remotePath("")));
  }

  private async put(filename: string, content: Uint8Array, contentType: string): Promise<void> {
    await this.withWebDAVError("CLOUD_BACKUP_WEBDAV_PUT_FAILED", async () => {
      await this.client.put(this.remotePath(filename), content, contentType);
    });
  }

  private async get(filename: string): Promise<Uint8Array> {
    return await this.withWebDAVError("CLOUD_BACKUP_WEBDAV_GET_FAILED", async () => await this.client.get(this.remotePath(filename), CLOUD_BACKUP_MAX_SNAPSHOT_BYTES));
  }

  private async deleteFile(filename: string): Promise<void> {
    try {
      await this.withWebDAVError("CLOUD_BACKUP_WEBDAV_DELETE_FAILED", async () => await this.client.delete(this.remotePath(filename)));
    } catch (error) {
      if (error instanceof CloudBackupRemoteError && error.code === "CLOUD_BACKUP_WEBDAV_NOT_FOUND") return;
      throw error;
    }
  }

  private async withWebDAVError<T>(code: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw await this.toWebDAVRemoteError(code, error);
    }
  }

  private async toWebDAVRemoteError(code: string, error: unknown): Promise<Error> {
    const response = webDAVResponseFromError(error);
    if (response) {
      const providerResponse = await cloudBackupProviderResponseFromFetchResponse(response, this.secretValues());
      const finalCode = webDAVErrorCodeForStatus(code, providerResponse);
      return new CloudBackupRemoteError(finalCode, cloudBackupRemoteErrorDetailsFromProviderResponse(finalCode, providerResponse));
    }
    const upstreamDetails = upstreamErrorDetailsFromError(error);
    if (upstreamDetails) return new CloudBackupRemoteError(code, upstreamDetails);
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`${message} (attempted host: ${this.attemptedHost})`);
  }

  private remotePath(filename: string): string {
    return joinWebDAVRemotePath(this.settings.path, filename);
  }

  private secretValues(): string[] {
    return [this.password];
  }
}

function webDAVResponseFromError(error: unknown): UpstreamFetchResponse | null {
  return error instanceof WorkerWebDAVRequestError ? error.response : null;
}

function webDAVErrorCodeForStatus(fallback: string, response: CloudBackupProviderResponse): string {
  return response.status === 404 ? "CLOUD_BACKUP_WEBDAV_NOT_FOUND" : fallback;
}

function providerHostSummary(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch { return endpoint; }
}

function joinWebDAVRemotePath(...parts: string[]): string {
  const segments = parts.flatMap((part) => part.split("/").map((segment) => segment.trim()).filter(Boolean));
  return segments.length > 0 ? `/${segments.join("/")}` : "/";
}

/** S3 适配器显式使用 fetch handler，避免 Worker 运行面落回 Node stream 语义。 */
export class S3CloudBackupClient implements CloudBackupRemoteClient {
  private readonly client: S3Client;
  private readonly capture: S3ProviderResponseCapture;
  private readonly endpointMode: S3EndpointMode;

  constructor(
    private readonly settings: CloudBackupS3Config,
    private readonly secret: string,
  ) {
    this.capture = new S3ProviderResponseCapture(this.secretValues());
    this.endpointMode = s3EndpointMode(settings);
    this.client = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      credentials: {
        accessKeyId: settings.accessKeyId ?? "",
        secretAccessKey: secret,
      },
      forcePathStyle: this.endpointMode === "pathStyleEndpoint",
      maxAttempts: 1,
      // Worker 用 fetch handler，Vitest 仍是 Node 进程；这里显式绑定 Web/Blob collector，避免 SDK 响应解析回退到 node streamCollector。
      streamCollector: collectS3SdkStream,
      requestChecksumCalculation: RequestChecksumCalculation.WHEN_REQUIRED,
      responseChecksumValidation: ResponseChecksumValidation.WHEN_REQUIRED,
      requestHandler: new S3CaptureRequestHandler(this.capture, this.secretValues()),
    });
  }

  async test(): Promise<void> {
    const key = this.key(`.renewlet-probe-${randomHex(4)}.txt`);
    const content = textEncoder.encode("renewlet-cloud-backup-probe");
    await this.putObject(key, content);
    try {
      const head = await this.headObject(key);
      if (head.contentLength !== null && head.contentLength !== content.length) throw new Error("CLOUD_BACKUP_S3_PROBE_MISMATCH");
      const got = await this.getObject(key);
      if (!bytesEqual(got, content)) throw new Error("CLOUD_BACKUP_S3_PROBE_MISMATCH");
    } finally {
      await this.deleteObject(key).catch(() => undefined);
    }
    // 测试连接必须覆盖 ListBucket 权限和地址模式；只 PUT/GET 探针会漏掉 COS/R2 列表失败。
    await this.listObjects(this.key(""));
  }

  async list(): Promise<CloudBackupSnapshotManifest[]> {
    const keys = await this.listObjects(this.key(""));
    const manifests: CloudBackupSnapshotManifest[] = [];
    for (const key of keys) {
      if (!key.endsWith(".manifest.json")) continue;
      const manifest = await this.getObject(key)
        .then((data) => cloudBackupSnapshotManifestSchema.parse(JSON.parse(textDecoder(data))))
        .catch(() => null);
      if (manifest) manifests.push(manifest);
    }
    return manifests;
  }

  async upload(filename: string, content: Uint8Array, manifest: CloudBackupSnapshotManifest): Promise<void> {
    const zipKey = this.key(filename);
    await this.putObject(zipKey, content);
    const head = await this.headObject(zipKey);
    if (head.contentLength !== null && head.contentLength !== content.length) throw new Error("CLOUD_BACKUP_S3_HEAD_MISMATCH");
    await this.putObject(this.key(manifestName(manifest.id)), textEncoder.encode(JSON.stringify(manifest, null, 2)));
  }

  async download(id: string): Promise<{ content: Uint8Array; manifest: CloudBackupSnapshotManifest }> {
    const manifest = cloudBackupSnapshotManifestSchema.parse(JSON.parse(textDecoder(await this.getObject(this.key(manifestName(id))))));
    return { content: await this.getObject(this.key(manifest.filename)), manifest };
  }

  async delete(id: string): Promise<void> {
    await this.deleteObject(this.key(`${id}.zip`));
    await this.deleteObject(this.key(manifestName(id)));
  }

  private key(filename: string): string {
    const prefix = this.settings.prefix.replace(/^\/+|\/+$/g, "");
    const cleanFilename = filename.replace(/^\/+|\/+$/g, "");
    if (!prefix) return cleanFilename;
    return cleanFilename ? `${prefix}/${cleanFilename}` : `${prefix}/`;
  }

  private async listObjects(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    const seenContinuationTokens = new Set<string>();
    do {
      const output = await this.listObjectsPage(prefix, continuationToken);
      keys.push(...output.keys);
      // S3 兼容服务偶发重复 continuation token 时必须停住，避免设置页列表请求死循环。
      const nextToken = output.nextContinuationToken;
      if (!nextToken || seenContinuationTokens.has(nextToken)) break;
      seenContinuationTokens.add(nextToken);
      continuationToken = nextToken;
    } while (continuationToken);
    return keys;
  }

  private async listObjectsPage(prefix: string, continuationToken: string | undefined): Promise<{ keys: string[]; nextContinuationToken?: string }> {
    this.capture.reset();
    try {
      // Worker 的 ListObjectsV2 走签名 fetch：SDK 负责签名和 endpoint，XML 解析由本 adapter 控制并回显 raw body。
      return await listS3ObjectsV2ViaSignedFetch({
        client: this.client,
        command: new ListObjectsV2Command({
          Bucket: this.settings.bucket,
          Prefix: prefix,
          MaxKeys: 1000,
          EncodingType: "url",
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
        secrets: this.secretValues(),
        setAttemptedHost: (host) => this.capture.setAttemptedHost(host),
      });
    } catch (error) {
      if (error instanceof S3ListObjectsError) throw new CloudBackupRemoteError(error.code, error.details);
      if (error instanceof CloudBackupRemoteError) throw error;
      throw this.capture.describeLocalError(error);
    }
  }

  private async putObject(key: string, content: Uint8Array): Promise<void> {
    await this.withCapturedS3Error("CLOUD_BACKUP_S3_PUT_FAILED", async () => await this.client.send(new PutObjectCommand({
      Bucket: this.settings.bucket,
      Key: key,
      Body: bytesForFetchBody(content),
      ContentType: contentTypeForS3Key(key),
    })));
  }

  private async headObject(key: string): Promise<{ contentLength: number | null }> {
    const output = await this.withCapturedS3Error("CLOUD_BACKUP_S3_HEAD_FAILED", async () => await this.client.send(new HeadObjectCommand({
      Bucket: this.settings.bucket,
      Key: key,
    })));
    return { contentLength: output.ContentLength ?? null };
  }

  private async getObject(key: string): Promise<Uint8Array> {
    const output = await this.withCapturedS3Error("CLOUD_BACKUP_S3_GET_FAILED", async () => await this.client.send(new GetObjectCommand({
      Bucket: this.settings.bucket,
      Key: key,
    })));
    return await sdkBodyBytes(output.Body, CLOUD_BACKUP_MAX_SNAPSHOT_BYTES);
  }

  private async deleteObject(key: string): Promise<void> {
    try {
      await this.withCapturedS3Error("CLOUD_BACKUP_S3_DELETE_FAILED", async () => await this.client.send(new DeleteObjectCommand({
        Bucket: this.settings.bucket,
        Key: key,
      })));
    } catch (error) {
      if (isS3NotFoundError(error)) return;
      throw error;
    }
  }

  private async withCapturedS3Error<T extends S3CommandOutput>(code: string, operation: () => Promise<T>): Promise<T> {
    this.capture.reset();
    try {
      return await operation();
    } catch (error) {
      const response = this.capture.last();
      if (response) throw new CloudBackupRemoteError(s3ErrorCodeForStatus(code, response), cloudBackupRemoteErrorDetailsFromProviderResponse(code, response));
      throw this.capture.describeLocalError(error);
    }
  }

  private secretValues(): string[] {
    return [this.settings.accessKeyId ?? "", this.secret];
  }
}

type S3CommandOutput = DeleteObjectCommandOutput | GetObjectCommandOutput | HeadObjectCommandOutput | PutObjectCommandOutput;

class S3ProviderResponseCapture {
  private response: CloudBackupProviderResponse | null = null;
  private attemptedHost: string | null = null;
  private attemptedRequest: { url: string; init: RequestInit } | null = null;

  constructor(private readonly secrets: readonly string[]) {}

  reset(): void {
    this.response = null;
    this.attemptedHost = null;
    this.attemptedRequest = null;
  }

  set(response: CloudBackupProviderResponse): void {
    this.response = response;
  }

  setAttemptedRequest(request: HttpRequest): void {
    const port = request.port ? `:${request.port}` : "";
    const origin = `${request.protocol}//${request.hostname}${port}`;
    this.setAttemptedHost(origin);
    this.attemptedRequest = {
      url: `${origin}${request.path}${smithyQueryString(request.query)}`,
      init: {
        method: request.method,
        headers: request.headers,
        ...(request.body ? { body: request.body as BodyInit } : {}),
      },
    };
  }

  setAttemptedHost(host: string): void {
    this.attemptedHost = host;
  }

  last(): CloudBackupProviderResponse | null {
    return this.response;
  }

  describeLocalError(error: unknown): CloudBackupRemoteError {
    if (this.attemptedRequest) {
      return new CloudBackupRemoteError("CLOUD_BACKUP_S3_LOCAL_FAILED", {
        rawResponseText: upstreamTransportDiagnosticMessage(
          this.attemptedRequest.url,
          this.attemptedRequest.init,
          { provider: "S3", secrets: this.secrets },
          error,
          CLOUD_BACKUP_UPSTREAM_TIMEOUT_MS,
          false,
        ),
      });
    }
    const message = error instanceof Error ? redactUpstreamSecrets(error.message, this.secrets) : redactUpstreamSecrets(String(error), this.secrets);
    // SDK 还没构造 HttpRequest 就失败时没有 path/query；只能退回非密 host 摘要，仍不回显签名 query 或凭据。
    return new CloudBackupRemoteError("CLOUD_BACKUP_S3_LOCAL_FAILED", {
      rawResponseText: this.attemptedHost ? `${message} (attempted host: ${this.attemptedHost})` : message,
    });
  }
}

function smithyQueryString(query: HttpRequest["query"]): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) {
      value.forEach((item) => params.append(key, item));
    } else if (typeof value === "string") {
      params.append(key, value);
    } else if (value === null) {
      params.append(key, "");
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

class S3CaptureRequestHandler implements RequestHandler<HttpRequest, HttpResponse, HttpHandlerOptions> {
  readonly metadata = { handlerProtocol: "h1" };
  private readonly handler = new FetchHttpHandler({ requestTimeout: 45_000 });

  constructor(
    private readonly capture: S3ProviderResponseCapture,
    private readonly secrets: readonly string[],
  ) {}

  destroy(): void {
    this.handler.destroy();
  }

  async handle(request: HttpRequest, options?: HttpHandlerOptions): Promise<RequestHandlerOutput<HttpResponse>> {
    this.capture.setAttemptedRequest(request);
    const output = await this.handler.handle(request, options);
    if (output.response.statusCode < 400) return output;
    // AWS SDK 仍需继续反序列化错误；读取后重放 body，同时只保存脱敏后的可见上游响应。
    const body = await readSmithyProviderResponseBody(output.response.body);
    this.capture.set({
      status: output.response.statusCode,
      statusText: output.response.reason || null,
      headers: headersRecordToObject(output.response.headers, this.secrets),
      body: body.text ? redactCloudBackupSecrets(body.text, this.secrets) : null,
      bodyTruncated: body.truncated,
    });
    output.response.body = body.bytes;
    return output;
  }
}

async function cloudBackupRemoteHTTPError(code: string, response: Response, secrets: readonly string[] = []): Promise<CloudBackupRemoteError> {
  return new CloudBackupRemoteError(code, await cloudBackupRemoteErrorDetails(code, response, secrets));
}

async function cloudBackupRemoteErrorDetails(code: string, response: Response, secrets: readonly string[]): Promise<CloudBackupErrorDetails> {
  const providerResponse = await cloudBackupProviderResponseFromFetchResponse(response, secrets);
  return cloudBackupRemoteErrorDetailsFromProviderResponse(code, providerResponse);
}

export function cloudBackupRemoteErrorDetailsFromProviderResponse(code: string, providerResponse: CloudBackupProviderResponse): CloudBackupErrorDetails {
  const providerMessage = providerResponse.body || providerResponse.statusText || code;
  return { rawResponseText: providerMessage };
}

async function cloudBackupProviderResponseFromFetchResponse(response: UpstreamFetchResponse, secrets: readonly string[]): Promise<CloudBackupProviderResponse> {
  return await upstreamProviderResponseFromFetchResponse(response, { secrets });
}

async function readSmithyProviderResponseBody(body: unknown): Promise<{ text: string; bytes: Uint8Array; truncated: boolean }> {
  const bytes = await bytesFromSdkBody(body, UPSTREAM_RAW_RESPONSE_TEXT_CAPTURE_MAX_CHARS + 1);
  const truncated = bytes.length > UPSTREAM_RAW_RESPONSE_TEXT_CAPTURE_MAX_CHARS;
  const visible = truncated ? bytes.slice(0, UPSTREAM_RAW_RESPONSE_TEXT_CAPTURE_MAX_CHARS) : bytes;
  return {
    text: textDecoder(visible),
    bytes: visible,
    truncated,
  };
}

async function sdkBodyBytes(body: unknown, limitBytes: number): Promise<Uint8Array> {
  return await bytesFromSdkBody(body, limitBytes + 1).then((bytes) => {
    if (bytes.length > limitBytes) throw new Error("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE");
    return bytes;
  });
}

async function bytesFromSdkBody(body: unknown, limitBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  if (body instanceof Uint8Array) return body.slice(0, limitBytes);
  if (body instanceof ArrayBuffer) return new Uint8Array(body).slice(0, limitBytes);
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return new Uint8Array(await body.slice(0, limitBytes).arrayBuffer());
  }
  if (isSdkByteArrayBody(body)) {
    const bytes = await body.transformToByteArray();
    return bytes.slice(0, limitBytes);
  }
  if (isReadableStreamBody(body)) {
    return await readReadableStreamBytes(body, limitBytes);
  }
  if (typeof body === "string") return textEncoder.encode(body).slice(0, limitBytes);
  return new Uint8Array();
}

async function collectS3SdkStream(body: unknown): Promise<Uint8Array> {
  // Workerd 的 Blob/ReadableStream API 会校验 32-bit 范围；SDK collector 不能用 MAX_SAFE_INTEGER 这种浏览器外也不稳的哨兵值。
  return await bytesFromSdkBody(body, CLOUD_BACKUP_MAX_SNAPSHOT_BYTES + 1);
}

type S3EndpointMode = "serviceEndpoint" | "pathStyleEndpoint";

function s3EndpointMode(settings: CloudBackupS3Config): S3EndpointMode {
  try {
    const url = new URL(settings.endpoint);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (s3EndpointUsesPathStyle(url, hostname)) return "pathStyleEndpoint";
    return "serviceEndpoint";
  } catch {
    return "serviceEndpoint";
  }
}

function s3EndpointUsesPathStyle(url: URL, hostname: string): boolean {
  // S3-compatible 没有通用供应商发现协议；这里只按客观网络形态退回 path-style，不按域名猜服务商或 bucket 绑定。
  if (url.port && url.port !== "443") return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true;
  return isIPv4Address(hostname) || hostname.includes(":");
}

function isIPv4Address(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

async function readReadableStreamBytes(stream: ReadableStream<Uint8Array>, limitBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = limitBytes - total;
    if (remaining <= 0) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    const chunk = value.length > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    total += chunk.length;
    if (value.length > remaining) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return concatUint8Arrays(chunks);
}

function isSdkByteArrayBody(body: unknown): body is { transformToByteArray: () => Promise<Uint8Array> } {
  return typeof body === "object"
    && body !== null
    && "transformToByteArray" in body
    && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function";
}

function isReadableStreamBody(body: unknown): body is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== "undefined" && body instanceof ReadableStream;
}

function headersRecordToObject(headers: Record<string, string> | undefined, secrets: readonly string[]): Record<string, string> | null {
  return recordToUpstreamHeaders(headers, secrets);
}

function s3ErrorCodeForStatus(fallback: string, response: CloudBackupProviderResponse): string {
  return response.status === 404 ? "CLOUD_BACKUP_S3_NOT_FOUND" : fallback;
}

function isS3NotFoundError(error: unknown): boolean {
  return error instanceof CloudBackupRemoteError && error.code === "CLOUD_BACKUP_S3_NOT_FOUND";
}

function redactCloudBackupSecrets(value: string, secrets: readonly string[]): string {
  return redactUpstreamSecrets(value, secrets);
}

function manifestName(id: string): string {
  return `${id.trim()}.manifest.json`;
}

export function snapshotId(date: Date): string {
  return `renewlet-export-v1-${formatSnapshotDate(date)}-${randomHex(4)}`;
}

function formatSnapshotDate(date: Date): string {
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function randomHex(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return hex(data);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytesForCrypto(data))));
}

function hex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function contentTypeForS3Key(key: string): string {
  if (key.endsWith(".manifest.json")) return "application/json";
  if (key.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

export function sanitizeDownloadFilename(filename: string): string {
  const base = filename.split("/").pop()?.trim().replaceAll("\"", "") || "renewlet-export-v1.zip";
  return base || "renewlet-export-v1.zip";
}

function textDecoder(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function concatUint8Arrays(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function bytesForFetchBody(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data);
}

function bytesForCrypto(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data);
}
