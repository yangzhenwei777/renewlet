import { CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS, type CloudBackupErrorDetails } from "@renewlet/shared/schemas/cloud-backup";

export type CleanupError = NonNullable<CloudBackupErrorDetails["cleanup"]>[number];

/** 云备份 remote error 直接保留失败阶段；details 只在当前请求返回，不进入 D1、备份包或缓存。 */
export class CloudBackupRemoteError extends Error {
  constructor(readonly code: string, readonly details?: CloudBackupErrorDetails) {
    super(code);
    this.name = "CloudBackupRemoteError";
  }
}

export function localRemoteError(code: string, provider: "s3" | "webdav" | "local", operation: string, target: string, message: string): CloudBackupRemoteError {
  const details = { operation, target: sanitizeCloudBackupTarget(target), clientMessage: truncate(message) } satisfies CloudBackupErrorDetails;
  return new CloudBackupRemoteError(code, provider === "local" ? details : { ...details, provider });
}

export function withCleanup(error: unknown, cleanup: CleanupError[]): CloudBackupRemoteError | Error {
  if (cleanup.length === 0) return error instanceof Error ? error : new Error(String(error));
  if (error instanceof CloudBackupRemoteError) {
    const details = error.details ?? { operation: "upload", target: "cloud backup" };
    return new CloudBackupRemoteError(error.code, { ...details, cleanup: [...(details.cleanup ?? []), ...cleanup].slice(0, 4) });
  }
  return new CloudBackupRemoteError(stableCloudBackupErrorCode(error instanceof Error ? error.message : String(error)) ?? "CLOUD_BACKUP_UPLOAD_FAILED", { operation: "upload", target: "cloud backup", clientMessage: truncate(error instanceof Error ? error.message : String(error)), cleanup });
}

export function cleanupError(operation: string, target: string, error: unknown): CleanupError {
  const remote = error instanceof CloudBackupRemoteError ? error : null;
  return {
    operation,
    target: sanitizeCloudBackupTarget(target),
    code: remote ? remote.code : "CLOUD_BACKUP_CLEANUP_FAILED",
    message: truncate(remote?.details?.clientMessage ?? remote?.details?.providerMessage ?? (error instanceof Error ? error.message : String(error))),
  };
}

export function requiredCapability(operation: string, status: number): string | undefined {
  if (status !== 401 && status !== 403) return undefined;
  if (["PutObject", "PUT", "MKCOL"].includes(operation)) return "object write permission";
  if (["HeadObject", "GetObject", "GET"].includes(operation)) return "object read permission";
  if (["ListObjectsV2", "LIST", "PROPFIND"].includes(operation)) return "bucket listing permission";
  if (["DeleteObject", "DELETE"].includes(operation)) return "object delete permission";
  return undefined;
}

export function isNotFound(error: unknown): boolean {
  if (error instanceof CloudBackupRemoteError) return error.details?.httpStatus === 404 || error.details?.providerCode === "NotFound" || error.details?.providerCode === "NoSuchKey";
  return false;
}

export function truncate(value: string): string {
  return value.length > CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS ? value.slice(0, CLOUD_BACKUP_DIAGNOSTIC_MAX_CHARS) : value;
}

export function stableCloudBackupErrorCode(value: string): string | null {
  const candidate = value.trim();
  return /^CLOUD_BACKUP_[A-Z0-9_]+$/.test(candidate) ? candidate : null;
}

export function sanitizeCloudBackupTarget(value: string): string {
  const sanitized = value.trim().replace(/[\u0000-\u001f\u007f]/g, " ");
  return sanitized.length > 1024 ? `${sanitized.slice(0, 1024)}…` : sanitized;
}

export function persistedCloudBackupErrorMessage(error: unknown): string {
  if (error instanceof CloudBackupRemoteError) return error.code;
  return stableCloudBackupErrorCode(error instanceof Error ? error.message : String(error)) ?? "local_sdk_error";
}
