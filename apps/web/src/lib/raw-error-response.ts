import { ApiError } from "@/lib/api-client";

export interface RawErrorResponseDetails {
  message: string;
  responseText: string;
}

// 详情弹窗的视图模型只承载“要展示的文本”；业务判断继续读 ApiError.code，避免 UI helper 重新变成错误协议层。
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getRawResponseTextField(value: Record<string, unknown>): string | null {
  const rawResponseText = value["rawResponseText"];
  return typeof rawResponseText === "string" && rawResponseText.length > 0 ? rawResponseText : null;
}

function getRawResponseTextFromApiErrorDetails(details: unknown): string | null {
  if (!isRecord(details)) return null;
  // API client 只把 envelope 内层 details 暴露给 UI；raw body 只能从这层一次性回显。
  return getRawResponseTextField(details);
}

export function formatRawErrorResponseText(responseText: string): string {
  if (!responseText.trim()) return responseText;
  try {
    return JSON.stringify(JSON.parse(responseText), null, 2);
  } catch {
    return responseText;
  }
}

export function createRawErrorResponseDetails(error: unknown, fallbackMessage = "Request failed"): RawErrorResponseDetails {
  if (error instanceof ApiError) {
    const message = error.message || fallbackMessage;
    const upstreamResponseText = getRawResponseTextFromApiErrorDetails(error.details);
    return {
      message,
      responseText: upstreamResponseText || error.rawResponseText || message,
    };
  }

  if (error instanceof Error) {
    const message = error.message || fallbackMessage;
    return {
      message,
      responseText: message,
    };
  }

  const message = fallbackMessage;
  return {
    message,
    responseText: typeof error === "string" && error.trim() ? error : message,
  };
}

export function createRawErrorResponseDetailsFromText(input: {
  code?: string | null | undefined;
  message?: string | null | undefined;
  responseText?: string | null | undefined;
}): RawErrorResponseDetails {
  const message = input.message?.trim() || input.code?.trim() || "Request failed";
  return {
    message,
    responseText: input.responseText && input.responseText.length > 0 ? input.responseText : message,
  };
}
