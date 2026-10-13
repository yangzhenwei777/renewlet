import { ApiError } from "@/lib/api-client";
import { cloudBackupErrorDetailsSchema, type CloudBackupErrorDetails } from "@renewlet/shared/schemas/cloud-backup";
import type { RawErrorResponseDetails } from "@/lib/raw-error-response";

export type CloudBackupErrorDetailsView = RawErrorResponseDetails & {
  code?: string | undefined;
  structured: CloudBackupErrorDetails | null;
};

// 详情只从当前 API error 提取；lastError 只保存阶段 code，避免把 provider 响应写入持久化状态。
export function extractCloudBackupErrorDetails(error: unknown, fallbackMessage = ""): CloudBackupErrorDetailsView | null {
  if (!(error instanceof ApiError)) return null;
  const parsed = cloudBackupErrorDetailsSchema.safeParse(error.details);
  return {
    message: error.message || fallbackMessage,
    responseText: parsed.success ? (parsed.data.clientMessage ?? parsed.data.providerMessage ?? (error.message || fallbackMessage)) : (error.message || fallbackMessage),
    ...(error.code !== undefined ? { code: error.code } : {}),
    structured: parsed.success ? parsed.data : null,
  };
}

export function createCloudBackupErrorDetails(error: unknown, fallbackMessage: string): CloudBackupErrorDetailsView {
  if (error instanceof ApiError) return extractCloudBackupErrorDetails(error, fallbackMessage) ?? {
    message: error.message || fallbackMessage,
    responseText: error.message || fallbackMessage,
    ...(error.code !== undefined ? { code: error.code } : {}),
    structured: null,
  };
  const message = error instanceof Error ? error.message || fallbackMessage : fallbackMessage;
  return { message, responseText: message, structured: null };
}
