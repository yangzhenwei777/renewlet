import {
  createRawErrorResponseDetails,
  type RawErrorResponseDetails,
} from "@/lib/raw-error-response";

export type CloudBackupErrorDetailsView = RawErrorResponseDetails;

// 云备份错误详情只从本次 API error 提取，不能读 lastError，避免把上游 raw response 写入状态页。
export function extractCloudBackupErrorDetails(error: unknown): CloudBackupErrorDetailsView | null {
  return createRawErrorResponseDetails(error);
}

export function createCloudBackupErrorDetails(error: unknown, fallbackMessage: string): CloudBackupErrorDetailsView {
  return createRawErrorResponseDetails(error, fallbackMessage);
}

export function cloudBackupErrorRawResponseText(details: CloudBackupErrorDetailsView | null): string {
  return details?.responseText || "";
}
