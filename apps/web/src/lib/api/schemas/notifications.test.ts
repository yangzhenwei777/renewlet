// 通知 schema 测试保护历史响应的空数组和 union 形状，避免前端为旧 null 契约恢复兼容层。
import { describe, expect, it } from "vitest";
import {
  notificationChannelSchema,
  notificationHistoryResponseSchema,
  notificationOverviewResponseSchema,
} from "./notifications";

const success = <T>(data: T) => ({ ok: true, data });

const skippedJob = {
  id: "job-1",
  scheduledLocalDate: "2026-05-17",
  scheduledLocalTime: "08:00",
  timeZone: "UTC",
  scheduledInstantUtc: "2026-05-17T08:00:00Z",
  status: "skipped",
  attempts: 1,
  lastError: null,
  result: {
    source: "cron",
    reason: "no_enabled_channels",
    force: false,
    windowMinutes: 2,
    triggeredAtUtc: "2026-05-17T08:00:00Z",
    schedule: {
      scheduledLocalDate: "2026-05-17",
      scheduledLocalTime: "08:00",
      timeZone: "UTC",
      scheduledInstantUtc: "2026-05-17T08:00:00Z",
    },
    settings: {
      timezone: "UTC",
      locale: "zh-CN",
      notificationTimeLocal: "08:00",
      enabledChannels: [],
      showExpired: true,
    },
    message: {
      title: "Renewlet 订阅提醒",
      content: "今天没有需要提醒的订阅。",
      timestamp: "2026-05-17 08:00:00 UTC",
      hasPayload: false,
      items: [],
    },
    channels: {
      attempted: [],
      succeeded: [],
      failed: [],
    },
  },
  createdAt: "2026-05-17T08:00:00Z",
  updatedAt: "2026-05-17T08:00:00Z",
};

const normalizedSkippedOverviewResponse = {
  summary: {
    nextCheck: {
      scheduledLocalDate: "2026-05-18",
      scheduledLocalTime: "08:00",
      timeZone: "UTC",
      scheduledInstantUtc: "2026-05-18T08:00:00Z",
    },
    nextContentBatch: null,
    blockers: ["no_enabled_channels"],
    enabledChannels: [],
    upcomingDays: 30,
    latestJob: skippedJob,
    latestFailedJob: null,
  },
  upcoming: [],
};

const normalizedSkippedHistoryResponse = {
  jobs: [skippedJob],
  status: "all",
  limit: 20,
  offset: 0,
  hasMore: false,
};

describe("notification API schemas", () => {
  it("accepts ServerChan as a notification channel", () => {
    expect(notificationChannelSchema.safeParse("serverchan").success).toBe(true);
  });

  it("accepts ServerChan channel snapshots in notification history", () => {
    const response = {
      ...normalizedSkippedHistoryResponse,
      jobs: [{
        ...skippedJob,
        result: {
          ...skippedJob.result,
          settings: {
            ...skippedJob.result.settings,
            enabledChannels: ["serverchan"],
          },
          channels: {
            attempted: ["serverchan"],
            succeeded: ["serverchan"],
            failed: [{
              channel: "serverchan",
              error: "Server酱响应格式无效",
            }],
          },
        },
      }],
    };

    expect(notificationHistoryResponseSchema.safeParse(success(response)).success).toBe(true);
  });

  it("accepts ServerChan channel snapshots in notification overview", () => {
    const response = {
      ...normalizedSkippedOverviewResponse,
      summary: {
        ...normalizedSkippedOverviewResponse.summary,
        enabledChannels: ["serverchan"],
        latestJob: {
          ...skippedJob,
          result: {
            ...skippedJob.result,
            settings: {
              ...skippedJob.result.settings,
              enabledChannels: ["serverchan"],
            },
            channels: {
              attempted: ["serverchan"],
              succeeded: ["serverchan"],
              failed: [{
                channel: "serverchan",
                error: "Server酱响应格式无效",
              }],
            },
          },
        },
      },
    };

    expect(notificationOverviewResponseSchema.safeParse(success(response)).success).toBe(true);
  });

  it("accepts normalized skipped history responses with empty arrays", () => {
    expect(notificationHistoryResponseSchema.safeParse(success(normalizedSkippedHistoryResponse)).success).toBe(true);
    expect(notificationHistoryResponseSchema.safeParse(normalizedSkippedHistoryResponse).success).toBe(false);
  });

  it("rejects legacy null channel arrays so the server contract stays strict", () => {
    const legacyNullResponse = {
      ...normalizedSkippedHistoryResponse,
      jobs: [{
        ...skippedJob,
        result: {
          ...skippedJob.result,
          channels: {
            ...skippedJob.result.channels,
            attempted: null,
          },
        },
      }],
    };

    expect(notificationHistoryResponseSchema.safeParse(success(legacyNullResponse)).success).toBe(false);
  });

  it("accepts repeat reminder snapshots on notification items", () => {
    const response = {
      ...normalizedSkippedHistoryResponse,
      jobs: [{
        ...skippedJob,
        result: {
          ...skippedJob.result,
          message: {
            ...skippedJob.result.message,
            hasPayload: true,
            items: [{
              type: "renewal",
              subscriptionId: "sub-1",
              name: "Critical SaaS",
              price: "99",
              currency: "USD",
              status: "active",
              targetDate: "2026-05-17",
              reminderDays: 3,
              daysUntil: 2,
              repeatReminder: {
                interval: "1h",
                window: "72h",
              },
            }],
          },
        },
      }],
    };

    expect(notificationHistoryResponseSchema.safeParse(success(response)).success).toBe(true);
  });

  it("rejects inherited reminder sentinel values in notification history payloads", () => {
    const response = {
      ...normalizedSkippedHistoryResponse,
      jobs: [{
        ...skippedJob,
        result: {
          ...skippedJob.result,
          message: {
            ...skippedJob.result.message,
            hasPayload: true,
            items: [{
              type: "renewal",
              subscriptionId: "sub-1",
              name: "Critical SaaS",
              price: "99",
              currency: "USD",
              status: "active",
              targetDate: "2026-05-17",
              reminderDays: -1,
              daysUntil: 2,
            }],
          },
        },
      }],
    };

    expect(notificationHistoryResponseSchema.safeParse(success(response)).success).toBe(false);
  });
});
