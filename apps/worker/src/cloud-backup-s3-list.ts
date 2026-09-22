import { type ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  type CloudBackupErrorDetails,
} from "@renewlet/shared/schemas/cloud-backup";
import { UPSTREAM_RAW_RESPONSE_TEXT_CAPTURE_MAX_CHARS } from "@renewlet/shared/schemas/upstream";
import { upstreamErrorDetailsFromError, type UpstreamProviderResponse } from "./upstream-response";
import { XMLParser } from "fast-xml-parser";
import { sendUpstreamRequest } from "./upstream-http";

type CloudBackupProviderResponse = UpstreamProviderResponse;

type S3ListObjectsRequest = {
  client: S3Client;
  command: ListObjectsV2Command;
  secrets: readonly string[];
  setAttemptedHost: (host: string) => void;
};

type S3ListObjectsPage = {
  keys: string[];
  nextContinuationToken?: string;
};

export class S3ListObjectsError extends Error {
  constructor(
    readonly code: string,
    readonly details: CloudBackupErrorDetails,
  ) {
    super(code);
    this.name = "S3ListObjectsError";
  }
}

const s3ListXmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (tagName) => tagName === "Contents",
});

const S3_SIGNED_FETCH_TIMEOUT_MS = 45_000;

export async function listS3ObjectsV2ViaSignedFetch(request: S3ListObjectsRequest): Promise<S3ListObjectsPage> {
  const signedUrl = await getSignedUrl(request.client, request.command, { expiresIn: 60 });
  const url = new URL(signedUrl);
  request.setAttemptedHost(`${url.protocol}//${url.host}`);
  let response: Response;
  try {
    // 预签名 URL 的 path/query 可用于定位 S3 兼容服务偏移，但签名、凭据和临时 token 必须在统一边界脱敏。
    response = await sendUpstreamRequest(url.toString(), { method: "GET" }, {
      provider: "S3 ListObjectsV2",
      secrets: request.secrets,
      timeoutMs: S3_SIGNED_FETCH_TIMEOUT_MS,
    });
  } catch (error) {
    const details = upstreamErrorDetailsFromError(error);
    throw new S3ListObjectsError("CLOUD_BACKUP_S3_LOCAL_FAILED", {
      rawResponseText: details?.rawResponseText ?? (error instanceof Error ? error.message : String(error)),
    });
  }
  const providerResponse = await s3ListProviderResponse(response, request.secrets);
  if (!response.ok) {
    throw new S3ListObjectsError(
      s3ErrorCodeForStatus("CLOUD_BACKUP_S3_LIST_FAILED", providerResponse),
      s3ListErrorDetailsFromProviderResponse("CLOUD_BACKUP_S3_LIST_FAILED", providerResponse),
    );
  }
  if (providerResponse.bodyTruncated) {
    throw new S3ListObjectsError("CLOUD_BACKUP_S3_LIST_FAILED", {
      rawResponseText: providerResponse.body || "CLOUD_BACKUP_S3_LIST_FAILED",
    });
  }
  try {
    // Workers 没有 DOMParser；AWS SDK browser XML deserializer 会在 S3 ListObjectsV2 的 200 XML 响应上崩溃，且 AWS 文档要求调用方能处理 200 invalid XML。
    return s3ListObjectsPageFromXml(providerResponse.body ?? "");
  } catch (error) {
    throw new S3ListObjectsError("CLOUD_BACKUP_S3_LIST_FAILED", {
      rawResponseText: error instanceof Error ? error.message : String(error),
    });
  }
}

function s3ListErrorDetailsFromProviderResponse(code: string, providerResponse: CloudBackupProviderResponse): CloudBackupErrorDetails {
  return { rawResponseText: providerResponse.body || providerResponse.statusText || code };
}

async function s3ListProviderResponse(response: Response, secrets: readonly string[]): Promise<CloudBackupProviderResponse> {
  const body = await readS3ListProviderResponseBody(response);
  return {
    status: response.status,
    statusText: response.statusText || null,
    headers: headersToObject(response.headers, secrets),
    body: body.text ? redactCloudBackupSecrets(body.text, secrets) : null,
    bodyTruncated: body.truncated,
  };
}

async function readS3ListProviderResponseBody(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > UPSTREAM_RAW_RESPONSE_TEXT_CAPTURE_MAX_CHARS) {
      const remaining = Math.max(0, UPSTREAM_RAW_RESPONSE_TEXT_CAPTURE_MAX_CHARS - text.length);
      if (remaining > 0) text += decoder.decode(value.slice(0, remaining), { stream: true });
      await reader.cancel().catch(() => undefined);
      return { text: text + decoder.decode(), truncated: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), truncated: false };
}

function s3ListObjectsPageFromXml(xml: string): S3ListObjectsPage {
  const root = objectRecord(s3ListXmlParser.parse(xml))?.["ListBucketResult"];
  if (root === "") return { keys: [] };
  const result = objectRecord(root);
  if (!result) throw new Error("S3 ListObjectsV2 response missing ListBucketResult");
  const contents = arrayOfRecords(result["Contents"]);
  const keys = contents.flatMap((item) => {
    const rawKey = stringValue(item["Key"]);
    return rawKey ? [decodeS3ListKey(rawKey)] : [];
  });
  const nextContinuationToken = stringValue(result["NextContinuationToken"]);
  return {
    keys,
    ...(nextContinuationToken ? { nextContinuationToken } : {}),
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((item) => {
    const record = objectRecord(item);
    return record ? [record] : [];
  });
  const record = objectRecord(value);
  return record ? [record] : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decodeS3ListKey(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

function headersToObject(headers: Headers, secrets: readonly string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!safeProviderResponseHeader(key)) return;
    const text = redactCloudBackupSecrets(value.trim(), secrets);
    if (text) out[key] = text;
  });
  return Object.keys(out).length > 0 ? out : null;
}

function safeProviderResponseHeader(key: string): boolean {
  const normalized = key.toLowerCase();
  if (normalized === "authorization" || normalized === "cookie" || normalized === "set-cookie") return false;
  return !normalized.includes("secret")
    && !normalized.includes("token")
    && !normalized.includes("credential")
    && !normalized.includes("signature")
    && !normalized.includes("accesskey")
    && !normalized.includes("access-key");
}

function s3ErrorCodeForStatus(fallback: string, response: CloudBackupProviderResponse): string {
  return response.status === 404 ? "CLOUD_BACKUP_S3_NOT_FOUND" : fallback;
}

function redactCloudBackupSecrets(value: string, secrets: readonly string[]): string {
  let out = value;
  for (const secret of normalizedCloudBackupSecrets(secrets)) {
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

function normalizedCloudBackupSecrets(secrets: readonly string[]): string[] {
  return Array.from(new Set(secrets.map((secret) => secret.trim()).filter((secret) => secret.length >= 4)));
}
