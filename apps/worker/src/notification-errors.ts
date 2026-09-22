import type { UpstreamErrorDetails } from "@renewlet/shared/schemas/upstream";

/**
 * 通知渠道错误的统一携带体。
 *
 * 渠道实现可以把脱敏后的上游 raw response 放进 details；调用方只能随当前 API 响应回显，
 * 不能把这些内容写入 notification_jobs、缓存或持久 lastError。
 */
export class NotificationChannelError extends Error {
  constructor(message: string, readonly details?: UpstreamErrorDetails) {
    super(message);
    this.name = "NotificationChannelError";
  }
}

/** 从任意异常中提取通知渠道上游详情；非渠道错误保持普通错误路径，避免误把内部异常展示成远端响应。 */
export function notificationChannelErrorDetails(error: unknown): UpstreamErrorDetails | undefined {
  return error instanceof NotificationChannelError ? error.details : undefined;
}
