import { CloudBackupRemoteError, localRemoteError, withCleanup, cleanupError, requiredCapability, isNotFound, truncate, stableCloudBackupErrorCode, sanitizeCloudBackupTarget, type CleanupError } from "./cloud-backup-errors";
export { CloudBackupRemoteError } from "./cloud-backup-errors";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { RequestChecksumCalculation, ResponseChecksumValidation } from "@aws-sdk/middleware-flexible-checksums";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { CronS3HttpHandler } from "./cloud-backup-s3-http";
import { CronBudgetExceeded, type CronBudget } from "./cron-budget";
import {
  CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS,
  CLOUD_BACKUP_MAX_SNAPSHOT_BYTES,
  cloudBackupSnapshotManifestSchema,
  type CloudBackupErrorDetails,
  type CloudBackupS3Config,
  type CloudBackupSnapshotManifest,
  type CloudBackupWebDavConfig,
} from "@renewlet/shared/schemas/cloud-backup";
import {
  readUpstreamResponseBody,
  redactUpstreamSecrets,
  type UpstreamFetchResponse,
  type UpstreamProviderResponse,
  upstreamHeadersToObject,
  upstreamProviderResponseFromFetchResponse,
  upstreamProviderResponseFromUnknown,
} from "./upstream-response";
import { WorkerWebDAVClient, WorkerWebDAVRequestError } from "./cloud-backup-webdav";

const textEncoder = new TextEncoder();
const CLOUD_BACKUP_UPSTREAM_TIMEOUT_MS = 45_000;
const CLOUD_BACKUP_S3_LIST_RESPONSE_MAX_KEYS = 1000;
const CLOUD_BACKUP_S3_LIST_RESPONSE_MAX_BYTES = 1024 * 1024;

type CloudBackupProviderResponse = UpstreamProviderResponse;
export type CloudBackupRemoteClient = {
  test(): Promise<void>;
  list(): Promise<CloudBackupSnapshotManifest[]>;
  upload(filename: string, content: Uint8Array, manifest: CloudBackupSnapshotManifest): Promise<void>;
  download(id: string): Promise<{ content: Uint8Array; manifest: CloudBackupSnapshotManifest }>;
  delete(id: string): Promise<void>;
};

export interface CloudBackupPagedRemoteClient extends CloudBackupRemoteClient {
  prepareDirectory(cursor: string | null, limit: number): Promise<string | null>;
  writeSnapshot(filename: string, content: Uint8Array): Promise<void>;
  verifySnapshot(manifest: Pick<CloudBackupSnapshotManifest, "filename" | "sizeBytes">): Promise<void>;
  writeManifest(manifest: CloudBackupSnapshotManifest): Promise<void>;
  listManifestPage(cursor: string | null, limit: number): Promise<{ keys: string[]; cursor: string | null }>;
  readManifest(key: string): Promise<CloudBackupSnapshotManifest>;
  deleteSnapshotFile(id: string, part: "zip" | "manifest"): Promise<void>;
  upload(filename: string, content: Uint8Array, manifest: CloudBackupSnapshotManifest, directoryPrepared?: boolean): Promise<void>;
  listPage(cursor: string | null, limit: number): Promise<{ manifests: CloudBackupSnapshotManifest[]; cursor: string | null }>;
}

/** WebDAV 协议库负责认证、XML 和请求；这一层只把业务对象名映射为远端路径并维护快照状态。 */
export class WebDAVCloudBackupClient implements CloudBackupPagedRemoteClient {
  private readonly client: WorkerWebDAVClient;
  private readonly diagnosticSecrets: readonly string[];

  constructor(private readonly settings: CloudBackupWebDavConfig, private readonly password: string, budget?: CronBudget) {
    this.diagnosticSecrets = [settings.username ?? "", password];
    this.client = new WorkerWebDAVClient({
      baseURL: settings.url,
      budget,
      username: settings.username ?? "",
      password,
      timeoutMs: CLOUD_BACKUP_UPSTREAM_TIMEOUT_MS,
    });
  }

  async test(): Promise<void> {
    await this.ensureDirectory();
    const filename = `.renewlet-probe-${randomHex(4)}.txt`;
    const content = textEncoder.encode("renewlet-cloud-backup-probe");
    await this.put(filename, content, "text/plain");
    let primaryError: unknown = null;
    try {
      const actual = await this.get(filename);
      if (!bytesEqual(actual, content)) {
        throw localRemoteError("CLOUD_BACKUP_WEBDAV_PROBE_MISMATCH", "webdav", "GET", this.remoteTarget(this.remotePath(filename)), "Probe object content does not match the uploaded bytes.");
      }
    } catch (error) {
      primaryError = error;
    }
    // 探针失败和探针清理是两个阶段；清理只能追加诊断，不能替换最先暴露权限或协议问题的阶段码。
    let cleanupFailure: unknown = null;
    try {
      await this.deleteFile(filename);
    } catch (error) {
      cleanupFailure = error;
    }
    if (primaryError) {
      const cleanup = cleanupFailure
        ? [cleanupError("DELETE", this.remotePath(filename), cleanupFailure)]
        : [];
      throw withCleanup(primaryError, cleanup);
    }
    if (cleanupFailure) throw cleanupFailure;
    await this.list();
  }

  async list(): Promise<CloudBackupSnapshotManifest[]> {
    await this.ensureDirectory();
    const directory = this.remotePath("");
    const files = await this.withError("CLOUD_BACKUP_WEBDAV_PROPFIND_FAILED", "PROPFIND", directory, () => this.client.list(directory));
    const manifests: CloudBackupSnapshotManifest[] = [];
    for (const filename of files) {
      if (!filename.endsWith(".manifest.json")) continue;
      const manifest = await this.readManifest(filename);
      manifests.push(manifest);
    }
    return manifests;
  }

  async listPage(cursor: string | null, limit: number): Promise<{ manifests: CloudBackupSnapshotManifest[]; cursor: string | null }> {
    const page = await this.listManifestPage(cursor, limit);
    const manifests: CloudBackupSnapshotManifest[] = [];
    for (const name of page.keys) manifests.push(await this.readManifest(name));
    return { manifests, cursor: page.cursor };
  }

  async listManifestPage(cursor: string | null, limit: number): Promise<{ keys: string[]; cursor: string | null }> {
    // WebDAV没有目录续传令牌；按不变文件名切片，正文由Cron在独立工作片读取。
    const directory = this.remotePath("");
    const files = (await this.withError("CLOUD_BACKUP_WEBDAV_PROPFIND_FAILED", "PROPFIND", directory, () => this.client.list(directory)))
      .filter((name) => name.endsWith(".manifest.json") && (cursor === null || name > cursor)).sort();
    const keys = files.slice(0, limit);
    return { keys, cursor: files.length > limit ? keys.at(-1) ?? null : null };
  }

  async prepareDirectory(cursor: string | null, limit: number): Promise<string | null> {
    const segments = this.remotePath("").split("/").filter(Boolean);
    const start = cursor ? cursor.split("/").filter(Boolean).length : 0;
    if (cursor && segments.slice(0, start).join("/") !== cursor) throw new Error("CLOUD_BACKUP_CURSOR_INVALID");
    const end = Math.min(segments.length, start + limit);
    for (let index = start; index < end; index++) {
      const path = segments.slice(0, index + 1).join("/");
      await this.withError("CLOUD_BACKUP_WEBDAV_MKCOL_FAILED", "MKCOL", path, () => this.client.ensureDirectory(path, false));
    }
    return end < segments.length ? segments.slice(0, end).join("/") : null;
  }

  async upload(filename: string, content: Uint8Array, manifest: CloudBackupSnapshotManifest, directoryPrepared = false): Promise<void> {
    if (!directoryPrepared) await this.ensureDirectory();
    await this.writeSnapshot(filename, content);
    try {
      await this.verifySnapshot({ filename, sizeBytes: content.length });
    } catch (error) {
      throw withCleanup(error, await this.cleanupFiles([filename]));
    }
    const manifestFilename = manifestName(manifest.id);
    try {
      await this.writeManifest(manifest);
    } catch (error) {
      throw withCleanup(error, await this.cleanupFiles([filename, manifestFilename]));
    }
  }

  async writeSnapshot(filename: string, content: Uint8Array): Promise<void> { await this.put(filename, content, "application/zip"); }

  async verifySnapshot(manifest: Pick<CloudBackupSnapshotManifest, "filename" | "sizeBytes">): Promise<void> {
    const path = this.remotePath(manifest.filename);
    const size = await this.withError("CLOUD_BACKUP_WEBDAV_PROPFIND_FAILED", "PROPFIND", path, () => this.client.stat(path));
    if (size !== manifest.sizeBytes) throw localRemoteError("CLOUD_BACKUP_WEBDAV_STAT_MISMATCH", "webdav", "PROPFIND", path, `Remote size ${size} bytes does not match uploaded size ${manifest.sizeBytes} bytes.`);
  }

  async writeManifest(manifest: CloudBackupSnapshotManifest): Promise<void> {
    await this.put(manifestName(manifest.id), textEncoder.encode(JSON.stringify(manifest, null, 2)), "application/json");
  }

  async deleteSnapshotFile(id: string, part: "zip" | "manifest"): Promise<void> { await this.deleteFile(part === "zip" ? `${id}.zip` : manifestName(id)); }

  async download(id: string): Promise<{ content: Uint8Array; manifest: CloudBackupSnapshotManifest }> {
    const manifest = await this.readManifest(manifestName(id));
    return { content: await this.get(manifest.filename), manifest };
  }

  async delete(id: string): Promise<void> {
    await this.deleteSnapshotFile(id, "zip");
    await this.deleteSnapshotFile(id, "manifest");
  }

  async readManifest(filename: string): Promise<CloudBackupSnapshotManifest> {
    try {
      return cloudBackupSnapshotManifestSchema.parse(JSON.parse(textDecoder(await this.get(filename))));
    } catch (error) {
      if (error instanceof CloudBackupRemoteError || error instanceof CronBudgetExceeded) throw error;
      throw localRemoteError("CLOUD_BACKUP_MANIFEST_INVALID", "webdav", "manifest", this.remoteTarget(this.remotePath(filename)), error instanceof Error ? error.message : String(error));
    }
  }

  private async ensureDirectory(): Promise<void> {
    const path = this.remotePath("");
    await this.withError("CLOUD_BACKUP_WEBDAV_MKCOL_FAILED", "MKCOL", path, () => this.client.ensureDirectory(path));
  }

  private async put(filename: string, content: Uint8Array, contentType: string): Promise<void> {
    const path = this.remotePath(filename);
    await this.withError("CLOUD_BACKUP_WEBDAV_PUT_FAILED", "PUT", path, () => this.client.put(path, content, contentType));
  }

  private async get(filename: string): Promise<Uint8Array> {
    const path = this.remotePath(filename);
    return await this.withError("CLOUD_BACKUP_WEBDAV_GET_FAILED", "GET", path, () => this.client.get(path, CLOUD_BACKUP_MAX_SNAPSHOT_BYTES));
  }

  private async deleteFile(filename: string): Promise<void> {
    const path = this.remotePath(filename);
    try {
      await this.withError("CLOUD_BACKUP_WEBDAV_DELETE_FAILED", "DELETE", path, () => this.client.delete(path));
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  private async cleanupFiles(filenames: readonly string[]): Promise<CleanupError[]> {
    const cleanup: CleanupError[] = [];
    for (const filename of filenames) {
      try {
        await this.deleteFile(filename);
      } catch (error) {
        cleanup.push(cleanupError("DELETE", this.remotePath(filename), error));
      }
    }
    return cleanup;
  }

  private async withError<T>(code: string, operation: string, path: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof CronBudgetExceeded) throw error;
      throw await webDavRemoteError(code, operation, this.remoteTarget(path), error, this.diagnosticSecrets);
    }
  }

  private remotePath(filename: string): string {
    return joinRemotePath(this.settings.path, filename);
  }

  private remoteTarget(path: string): string {
    const base = new URL(this.settings.url);
    const root = base.pathname.replace(/\/+$/, "");
    return `host=${base.host}; path=${root}${path}`;
  }
}

/** S3 适配器只调用 AWS SDK command；endpoint、寻址和签名全部留在 SDK 公共客户端内。 */
class S3ObjectStore {
  readonly client: S3Client;
  private readonly diagnosticSecrets: readonly string[];

  constructor(readonly settings: CloudBackupS3Config, private readonly secret: string, budget?: CronBudget) {
    this.diagnosticSecrets = [settings.accessKeyId ?? "", secret];
    this.client = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      credentials: { accessKeyId: settings.accessKeyId ?? "", secretAccessKey: secret },
      forcePathStyle: settings.addressingStyle === "pathStyle",
      // 私有对象必须直达源站；Cloudflare 缓存可能把 ZIP 的 HEAD 改为 GET，破坏包含方法的 SigV4 签名。
      requestHandler: budget ? new CronS3HttpHandler(budget, CLOUD_BACKUP_UPSTREAM_TIMEOUT_MS)
        : new FetchHttpHandler({ cache: "no-store", requestTimeout: CLOUD_BACKUP_UPSTREAM_TIMEOUT_MS }),
      maxAttempts: 1,
      requestChecksumCalculation: RequestChecksumCalculation.WHEN_REQUIRED,
      responseChecksumValidation: ResponseChecksumValidation.WHEN_REQUIRED,
    });
    // SDK 解析会消费正文；只给列表和失败响应做有界缓冲，保留真实诊断，成功 ZIP 下载继续流式读取。
    this.client.middlewareStack.add((next, context) => async (args) => {
      const result = await next(args);
      const response = asRecord(result.response);
      const status = numberValue(response?.["statusCode"]) ?? 0;
      const listing = context.commandName === "ListObjectsV2Command" && status < 300;
      if (response && (listing || status >= 300)) {
        const limit = listing ? CLOUD_BACKUP_S3_LIST_RESPONSE_MAX_BYTES : CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS;
        try {
          const body = await readUpstreamResponseBody({ body: response["body"] }, limit + 1);
          const bytes = textEncoder.encode(body.text);
          response["body"] = bytes;
          if (listing && (body.truncated || bytes.byteLength > limit)) {
            throw new Error(`S3 ListObjectsV2 response exceeded the ${limit}-byte limit.`);
          }
        } catch (error) {
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { $response: response });
        }
      }
      return result;
    }, { step: "deserialize", name: "renewletBoundS3Response", priority: "low" });
    if (settings.addressingStyle === "virtualHost") {
      this.client.middlewareStack.add((next) => async (args) => {
        const request = args.request as { hostname?: string } | undefined;
        const hostname = request?.hostname?.toLowerCase() ?? "";
        const bucket = settings.bucket.toLowerCase();
        if (!hostname || (hostname !== bucket && !hostname.startsWith(`${bucket}.`))) {
          throw new CloudBackupRemoteError("CLOUD_BACKUP_S3_VIRTUAL_HOST_INVALID", {
            provider: "s3",
            operation: "endpoint",
            target: `host=${endpointHost(settings.endpoint)}; bucket=${settings.bucket}`,
            clientMessage: "SDK did not resolve a virtual-hosted endpoint containing the configured bucket; no request was sent.",
          });
        }
        return next(args);
      }, { step: "build", name: "renewletValidateVirtualHost", priority: "high" });
    }
  }

  async putObject(key: string, body: Uint8Array): Promise<void> {
    await this.send("CLOUD_BACKUP_S3_PUT_FAILED", "PutObject", key, () => this.client.send(new PutObjectCommand({ Bucket: this.settings.bucket, Key: key, Body: bytesForBody(body), ContentType: contentTypeForS3Key(key) })));
  }

  async headObject(key: string): Promise<{ contentLength: number | null }> {
    const output = await this.send("CLOUD_BACKUP_S3_HEAD_FAILED", "HeadObject", key, () => this.client.send(new HeadObjectCommand({ Bucket: this.settings.bucket, Key: key })));
    return { contentLength: output.ContentLength ?? null };
  }

  async getObject(key: string): Promise<Uint8Array> {
    const output = await this.send("CLOUD_BACKUP_S3_GET_FAILED", "GetObject", key, () => this.client.send(new GetObjectCommand({ Bucket: this.settings.bucket, Key: key })));
    try {
      return await sdkBodyBytes(output.Body, CLOUD_BACKUP_MAX_SNAPSHOT_BYTES);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /^CLOUD_BACKUP_[A-Z0-9_]+$/.test(message) ? message : "CLOUD_BACKUP_S3_GET_FAILED";
      throw localRemoteError(code, "s3", "GetObject", this.target(key), message);
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.send("CLOUD_BACKUP_S3_DELETE_FAILED", "DeleteObject", key, () => this.client.send(new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: key })));
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  async listObjects(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    const seenTokens = new Set<string>();
    for (;;) {
      const input = {
        Bucket: this.settings.bucket,
        MaxKeys: CLOUD_BACKUP_S3_LIST_RESPONSE_MAX_KEYS,
        EncodingType: "url" as const,
        ...(prefix ? { Prefix: prefix } : {}),
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      };
      const output = await this.send("CLOUD_BACKUP_S3_LIST_FAILED", "ListObjectsV2", prefix, () => this.client.send(new ListObjectsV2Command(input)));
      for (const item of output.Contents ?? []) if (item.Key) keys.push(item.Key);
      const next = output.NextContinuationToken;
      if (!next || seenTokens.has(next)) return keys;
      seenTokens.add(next);
      continuationToken = next;
    }
  }

  async listObjectPage(prefix: string, cursor: string | null, limit: number): Promise<{ keys: string[]; cursor: string | null }> {
    const output = await this.send("CLOUD_BACKUP_S3_LIST_FAILED", "ListObjectsV2", prefix, () => this.client.send(new ListObjectsV2Command({
      Bucket: this.settings.bucket, MaxKeys: limit, EncodingType: "url",
      ...(prefix ? { Prefix: prefix } : {}), ...(cursor ? { ContinuationToken: cursor } : {}),
    })));
    if (output.NextContinuationToken && output.NextContinuationToken === cursor) {
      throw localRemoteError("CLOUD_BACKUP_S3_LIST_FAILED", "s3", "ListObjectsV2", this.target(prefix), "Repeated continuation token");
    }
    return { keys: (output.Contents ?? []).flatMap((item) => item.Key ? [item.Key] : []), cursor: output.NextContinuationToken ?? null };
  }

  private async send<T>(code: string, operation: string, key: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof CloudBackupRemoteError || error instanceof CronBudgetExceeded) throw error;
      throw await s3RemoteError(code, operation, this.target(key), error, this.diagnosticSecrets);
    }
  }

  private target(key: string): string {
    return sanitizeCloudBackupTarget(`host=${endpointHost(this.settings.endpoint)}; bucket=${this.settings.bucket}; key=${key || "(bucket root)"}`);
  }
}

export class S3CloudBackupClient implements CloudBackupPagedRemoteClient {
  private readonly store: S3ObjectStore;

  constructor(private readonly settings: CloudBackupS3Config, secret: string, budget?: CronBudget) {
    this.store = new S3ObjectStore(settings, secret, budget);
  }

  async prepareDirectory(_cursor: string | null, _limit: number): Promise<null> { return null; }

  async test(): Promise<void> {
    const key = this.key(`.renewlet-probe-${randomHex(4)}.txt`);
    const content = textEncoder.encode("renewlet-cloud-backup-probe");
    await this.store.putObject(key, content);
    let primaryError: unknown = null;
    try {
      const head = await this.store.headObject(key);
      if (head.contentLength !== null && head.contentLength !== content.length) throw localRemoteError("CLOUD_BACKUP_S3_PROBE_MISMATCH", "s3", "HeadObject", this.target(key), `Remote size ${head.contentLength} bytes does not match probe size ${content.length} bytes.`);
      const actual = await this.store.getObject(key);
      if (!bytesEqual(actual, content)) throw localRemoteError("CLOUD_BACKUP_S3_PROBE_MISMATCH", "s3", "GetObject", this.target(key), "Probe object content does not match the uploaded bytes.");
    } catch (error) {
      primaryError = error;
    }
    // 探针失败和探针清理是两个阶段；清理只能追加诊断，不能替换最先暴露权限或协议问题的阶段码。
    let cleanupFailure: unknown = null;
    try {
      await this.store.deleteObject(key);
    } catch (error) {
      cleanupFailure = error;
    }
    if (primaryError) {
      const cleanup = cleanupFailure
        ? [cleanupError("DeleteObject", this.target(key), cleanupFailure)]
        : [];
      throw withCleanup(primaryError, cleanup);
    }
    if (cleanupFailure) throw cleanupFailure;
    await this.store.listObjects(this.key(""));
  }

  async list(): Promise<CloudBackupSnapshotManifest[]> {
    const manifests: CloudBackupSnapshotManifest[] = [];
    for (const key of await this.store.listObjects(this.key(""))) {
      if (!key.endsWith(".manifest.json")) continue;
      manifests.push(await this.readManifest(key));
    }
    return manifests;
  }

  async listPage(cursor: string | null, limit: number): Promise<{ manifests: CloudBackupSnapshotManifest[]; cursor: string | null }> {
    const page = await this.listManifestPage(cursor, limit);
    const manifests: CloudBackupSnapshotManifest[] = [];
    for (const key of page.keys) manifests.push(await this.readManifest(key));
    return { manifests, cursor: page.cursor };
  }

  async listManifestPage(cursor: string | null, limit: number): Promise<{ keys: string[]; cursor: string | null }> {
    const page = await this.store.listObjectPage(this.key(""), cursor, limit);
    return { ...page, keys: page.keys.filter((key) => key.endsWith(".manifest.json")) };
  }

  async upload(filename: string, content: Uint8Array, manifest: CloudBackupSnapshotManifest): Promise<void> {
    const zipKey = this.key(filename);
    await this.writeSnapshot(filename, content);
    const cleanupKeys = [zipKey];
    try {
      await this.verifySnapshot({ filename, sizeBytes: content.length });
      const manifestKey = this.key(manifestName(manifest.id));
      cleanupKeys.push(manifestKey);
      await this.writeManifest(manifest);
    } catch (error) {
      throw withCleanup(error, await this.cleanup(cleanupKeys));
    }
  }

  async writeSnapshot(filename: string, content: Uint8Array): Promise<void> { await this.store.putObject(this.key(filename), content); }

  async verifySnapshot(manifest: Pick<CloudBackupSnapshotManifest, "filename" | "sizeBytes">): Promise<void> {
    const key = this.key(manifest.filename);
    const head = await this.store.headObject(key);
    if (head.contentLength !== null && head.contentLength !== manifest.sizeBytes) throw localRemoteError("CLOUD_BACKUP_S3_HEAD_MISMATCH", "s3", "HeadObject", this.target(key), `Remote size ${head.contentLength} bytes does not match uploaded size ${manifest.sizeBytes} bytes.`);
  }

  async writeManifest(manifest: CloudBackupSnapshotManifest): Promise<void> { await this.store.putObject(this.key(manifestName(manifest.id)), textEncoder.encode(JSON.stringify(manifest, null, 2))); }

  async deleteSnapshotFile(id: string, part: "zip" | "manifest"): Promise<void> { await this.store.deleteObject(this.key(part === "zip" ? `${id}.zip` : manifestName(id))); }

  async download(id: string): Promise<{ content: Uint8Array; manifest: CloudBackupSnapshotManifest }> {
    const manifest = await this.readManifest(this.key(manifestName(id)));
    return { content: await this.store.getObject(this.key(manifest.filename)), manifest };
  }

  async delete(id: string): Promise<void> {
    await this.deleteSnapshotFile(id, "zip");
    await this.deleteSnapshotFile(id, "manifest");
  }

  async readManifest(key: string): Promise<CloudBackupSnapshotManifest> {
    try {
      return cloudBackupSnapshotManifestSchema.parse(JSON.parse(textDecoder(await this.store.getObject(key))));
    } catch (error) {
      if (error instanceof CloudBackupRemoteError || error instanceof CronBudgetExceeded) throw error;
      throw localRemoteError("CLOUD_BACKUP_MANIFEST_INVALID", "s3", "manifest", this.target(key), error instanceof Error ? error.message : String(error));
    }
  }

  private async cleanup(keys: readonly string[]): Promise<CleanupError[]> {
    const cleanup: CleanupError[] = [];
    for (const key of keys) {
      try {
        await this.store.deleteObject(key);
      } catch (error) {
        cleanup.push(cleanupError("DeleteObject", this.target(key), error));
      }
    }
    return cleanup;
  }

  private key(filename: string): string {
    const prefix = this.settings.prefix.replace(/^\/+|\/+$/g, "");
    const clean = filename.replace(/^\/+|\/+$/g, "");
    if (!prefix) return clean;
    return clean ? `${prefix}/${clean}` : `${prefix}/`;
  }

  private target(key: string): string {
    return sanitizeCloudBackupTarget(`host=${endpointHost(this.settings.endpoint)}; bucket=${this.settings.bucket}; key=${key || "(bucket root)"}`);
  }
}

async function s3RemoteError(code: string, operation: string, target: string, error: unknown, secrets: readonly string[]): Promise<CloudBackupRemoteError> {
  const record = asRecord(error);
  const metadata = asRecord(record?.["$metadata"]);
  const response = await s3ProviderResponse(record?.["$response"], secrets);
  const status = numberValue(metadata?.["httpStatusCode"]) ?? response?.status ?? undefined;
  const serviceError = error instanceof S3ServiceException;
  // HEAD 失败通常没有正文；SDK 合成的异常名/消息不能冒充服务端响应，也不能据此断言权限不足。
  const providerMessage = response?.body;
  // 2xx 之后仍可能在 SDK 反序列化时失败；本地异常不能充当 provider code，也不能被响应正文覆盖。
  const clientMessage = serviceError ? undefined : truncate(redactUpstreamSecrets(
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    secrets,
  ));
  const providerCode = providerCodeFromBody(response?.body ?? undefined);
  const requestId = stringValue(metadata?.["requestId"])
    ?? stringValue(metadata?.["extendedRequestId"])
    ?? response?.headers?.["x-amz-request-id"]
    ?? response?.headers?.["x-amz-id-2"];
  return new CloudBackupRemoteError(code, {
    provider: "s3",
    operation,
    target,
    ...(status ? { httpStatus: status, httpStatusText: statusText(status), requiredCapability: requiredCapability(operation, status) } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(requestId ? { requestId } : {}),
    ...(providerMessage ? { providerMessage } : {}),
    ...(clientMessage ? { clientMessage } : {}),
  });
}

async function s3ProviderResponse(value: unknown, secrets: readonly string[]): Promise<CloudBackupProviderResponse | null> {
  const response = asRecord(value);
  if (!response) return null;
  const body = response["body"];
  let bodyText: string | undefined;
  let bodyTruncated = false;
  if (typeof body === "string") {
    const bounded = boundedDiagnosticText(body);
    bodyText = bounded.text;
    bodyTruncated = bounded.truncated;
  } else if (body instanceof Uint8Array) {
    const bounded = boundedDiagnosticText(new TextDecoder().decode(body.slice(0, CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS + 1)));
    bodyText = bounded.text;
    bodyTruncated = bounded.truncated || body.byteLength > CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS;
  } else if (body) {
    try {
      const bounded = boundedDiagnosticText(textDecoder(await sdkBodyBytes(body, CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS + 1)));
      bodyText = bounded.text;
      bodyTruncated = bounded.truncated;
    } catch {
      bodyText = undefined;
    }
  }
  const status = numberValue(response["statusCode"]);
  const headers = response["headers"];
  const normalized = upstreamProviderResponseFromUnknown({
    status,
    statusText: status ? statusText(status) : undefined,
    headers,
    body: bodyText,
    bodyTruncated,
  }, secrets);
  return normalized.status || normalized.body || normalized.headers ? normalized : null;
}

async function webDavRemoteError(code: string, operation: string, target: string, error: unknown, secrets: readonly string[]): Promise<CloudBackupRemoteError> {
  const requestError = error instanceof WorkerWebDAVRequestError ? error : null;
  const response = await webDavProviderResponse(requestError?.response ?? null, secrets);
  const providerCode = providerCodeFromBody(response?.body ?? undefined);
  const causeMessage = requestError?.cause instanceof Error ? requestError.cause.message : "";
  const effectiveCode = !response && /^CLOUD_BACKUP_[A-Z0-9_]+$/.test(causeMessage) ? causeMessage : code;
  const httpStatus = response?.status ?? undefined;
  const required = httpStatus === undefined ? undefined : requiredCapability(operation, httpStatus);
  return new CloudBackupRemoteError(effectiveCode, {
    provider: "webdav",
    operation,
    target: sanitizeCloudBackupTarget(requestError?.target ?? target),
    ...(httpStatus !== undefined ? {
      httpStatus,
      ...(response?.statusText ? { httpStatusText: response.statusText } : {}),
      ...(required ? { requiredCapability: required } : {}),
    } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(response?.body ? { providerMessage: truncate(response.body) } : {}),
    ...(!response && error instanceof Error ? { clientMessage: truncate(redactUpstreamSecrets(causeMessage || error.message, secrets)) } : {}),
  });
}

async function webDavProviderResponse(response: Response | null, secrets: readonly string[]): Promise<CloudBackupProviderResponse | null> {
  if (!response) return null;
  try {
    return await upstreamProviderResponseFromFetchResponse(response as UpstreamFetchResponse, { secrets });
  } catch {
    // webdav 可能已消费失败 body；状态和安全 headers 仍足以保留阶段与权限诊断，不能让捕获异常覆盖原始错误。
    return upstreamProviderResponseFromUnknown({
      status: response.status,
      statusText: response.statusText,
      headers: upstreamHeadersToObject(response.headers, secrets),
    }, secrets);
  }
}






function joinRemotePath(...parts: string[]): string {
  const segments = parts.flatMap((part) => part.split("/").map((segment) => segment.trim()).filter(Boolean));
  return segments.length ? `/${segments.join("/")}` : "/";
}

function manifestName(id: string): string {
  return `${id.trim()}.manifest.json`;
}

export function snapshotId(date: Date): string {
  return `renewlet-export-v1-${date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomHex(4)}`;
}

function randomHex(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return hex(data);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data))));
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
  return filename.split("/").pop()?.trim().replaceAll("\"", "") || "renewlet-export-v1.zip";
}

function textDecoder(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function bytesForBody(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data);
}

async function sdkBodyBytes(body: unknown, limit: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  if (typeof body === "object" && body !== null && "transformToWebStream" in body && typeof (body as { transformToWebStream?: unknown }).transformToWebStream === "function") {
    return boundedStream((body as { transformToWebStream: () => ReadableStream<Uint8Array> }).transformToWebStream(), limit);
  }
  if (typeof body === "object" && body !== null && "transformToByteArray" in body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    return boundedBytes(await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray(), limit);
  }
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return boundedStream(body, limit);
  if (body instanceof Uint8Array) return boundedBytes(body, limit);
  if (body instanceof ArrayBuffer) return boundedBytes(new Uint8Array(body), limit);
  return new Uint8Array();
}

function boundedBytes(bytes: Uint8Array, limit: number): Uint8Array {
  if (bytes.length > limit) throw new Error("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE");
  return bytes;
}

async function boundedStream(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) throw new Error("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}


function boundedDiagnosticText(value: string): { text: string; truncated: boolean } {
  // provider 错误正文只作为当前请求的诊断现场，先在统一响应层限长，再交给 schema，避免异常响应造成无界内存或泄漏。
  if (value.length <= CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS), truncated: true };
}

function providerCodeFromBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const xml = body.match(/<(?:(?:[A-Za-z0-9_.-]+):)?Code>\s*([^<\s][^<]{0,255}?)\s*<\//i)?.[1];
  if (xml) return xml.trim();
  const json = body.match(/"(?:Code|code)"\s*:\s*"([^"]{1,256})"/i)?.[1];
  return json?.trim() || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function statusText(status: number): string {
  return ({
    200: "OK",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    408: "Request Timeout",
    409: "Conflict",
    413: "Payload Too Large",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  } as Record<number, string>)[status] ?? "";
}


function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "configured endpoint";
  }
}
