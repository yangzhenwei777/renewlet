import {
  createRawErrorResponseDetails,
  type RawErrorResponseDetails,
} from "@/lib/raw-error-response";

export type AIErrorDetails = RawErrorResponseDetails;

// AI 错误详情复用统一 raw response 契约，避免 provider body 在 AI 模块里出现第二套持久化路径。
export function extractAIErrorDetails(error: unknown): AIErrorDetails | null {
  return createRawErrorResponseDetails(error);
}

export function createAIErrorDetails(error: unknown, fallbackMessage: string): AIErrorDetails {
  return createRawErrorResponseDetails(error, fallbackMessage);
}

export function aiErrorRawResponseText(details: AIErrorDetails | null): string {
  return details?.responseText || "";
}
