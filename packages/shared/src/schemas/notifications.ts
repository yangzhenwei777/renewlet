import { z } from "zod";
import {
  NOTIFICATION_CHANNELS,
  REPEAT_REMINDER_INTERVALS,
  REPEAT_REMINDER_WINDOWS,
  SUBSCRIPTION_STATUSES,
  isValidDateOnly,
  isValidLocalTime,
  type DateOnly,
  type LocalTime,
} from "../runtime";
import { apiSuccessResponseSchema } from "./api";
import { okResponseSchema } from "./common";
import { moneyStringSchema } from "../money";
import { settingsUpdateBodySchema } from "./settings";
import { upstreamErrorDetailsSchema } from "./upstream";

export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

export const notificationsTestBodySchema = z.object({
  channel: notificationChannelSchema,
  settings: settingsUpdateBodySchema.optional(),
}).strict();

export const notificationsRunBodySchema = z.object({
  force: z.boolean().optional(),
  settings: settingsUpdateBodySchema.optional(),
}).strict();

const dateOnlyResponseSchema = z.string().refine(isValidDateOnly, "Invalid date").transform((value) => value as DateOnly);
const localTimeResponseSchema = z.string().refine(isValidLocalTime, "Invalid local time").transform((value) => value as LocalTime);

// 调度历史必须同时保存本地墙钟时间和 UTC instant：前者给用户解释，后者给排序/审计。
export const localScheduleOccurrenceResponseSchema = z.object({
  scheduledLocalDate: dateOnlyResponseSchema,
  scheduledLocalTime: localTimeResponseSchema,
  timeZone: z.string().min(1),
  scheduledInstantUtc: z.string().min(1),
}).strict();

const notificationCostSharingPayloadResponseSchema = z.object({
  memberName: z.string().trim().min(1).max(80),
  amount: moneyStringSchema,
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
}).strict();

export const notificationContentItemResponseSchema = z.object({
  type: z.enum(["renewal", "trial", "expired", "expiry", "costSharing"]),
  subscriptionId: z.string(),
  name: z.string(),
  price: moneyStringSchema,
  currency: z.string(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  targetDate: dateOnlyResponseSchema,
  reminderDays: z.number().int().nonnegative(),
  daysUntil: z.number().int(),
  repeatReminder: z.object({
    interval: z.enum(REPEAT_REMINDER_INTERVALS),
    window: z.enum(REPEAT_REMINDER_WINDOWS),
  }).strict().optional(),
  // costSharing item 逐成员保存应收信息；后端不做汇率猜测，只写入订阅币种或成员配置币种。
  costSharing: notificationCostSharingPayloadResponseSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.type === "costSharing" && !value.costSharing) {
    ctx.addIssue({
      code: "custom",
      path: ["costSharing"],
      message: "Cost sharing payload is required",
    });
  }
  if (value.type !== "costSharing" && value.costSharing) {
    ctx.addIssue({
      code: "custom",
      path: ["costSharing"],
      message: "Cost sharing payload is only allowed for cost sharing items",
    });
  }
});

export const upcomingNotificationBatchResponseSchema = localScheduleOccurrenceResponseSchema.extend({
  items: z.array(notificationContentItemResponseSchema),
}).strict();

export const channelFailureResponseSchema = z.object({
  channel: notificationChannelSchema,
  error: z.string(),
  details: upstreamErrorDetailsSchema.optional(),
}).strict();

export const jobChannelsResponseSchema = z.object({
  attempted: z.array(notificationChannelSchema),
  succeeded: z.array(notificationChannelSchema),
  failed: z.array(channelFailureResponseSchema),
}).strict();

/**
 * 手动运行和 Cron 运行共用的通知任务结果。
 *
 * Go 与 Cloudflare 都按这个结构表达“计划时间、候选内容、渠道结果”，前端历史页不需要理解
 * 具体运行面；空对象只表示本次没有可持久化的任务结果。
 */
export const cronJobResultResponseSchema = z.object({
  source: z.literal("cron"),
  reason: z.string().nullable(),
  force: z.boolean(),
  windowMinutes: z.number().int().nonnegative(),
  triggeredAtUtc: z.string(),
  schedule: localScheduleOccurrenceResponseSchema,
  settings: z.object({
    timezone: z.string(),
    locale: z.string(),
    notificationTimeLocal: localTimeResponseSchema,
    enabledChannels: z.array(notificationChannelSchema),
    showExpired: z.boolean(),
  }).strict(),
  message: z.object({
    title: z.string(),
    content: z.string(),
    timestamp: z.string(),
    hasPayload: z.boolean(),
    items: z.array(notificationContentItemResponseSchema),
  }).strict(),
  channels: jobChannelsResponseSchema,
}).strict();

export const emptyJobResultResponseSchema = z.object({}).strict();
export const notificationJobResultResponseSchema = z.union([cronJobResultResponseSchema, emptyJobResultResponseSchema]);
export const notificationHistoryStatusSchema = z.enum(["all", "sent", "failed", "skipped", "sending"]);
export const notificationJobStatusSchema = z.enum(["pending", "sending", "sent", "failed", "skipped"]);

/** 通知历史行是审计契约，必须保留本地计划时间、UTC instant 和渠道执行结果三组信息。 */
export const notificationHistoryJobResponseSchema = z.object({
  id: z.string(),
  scheduledLocalDate: dateOnlyResponseSchema,
  scheduledLocalTime: localTimeResponseSchema,
  timeZone: z.string(),
  scheduledInstantUtc: z.string(),
  status: notificationJobStatusSchema,
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  result: notificationJobResultResponseSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

export const notificationOverviewPayloadSchema = z.object({
  summary: z.object({
    nextCheck: localScheduleOccurrenceResponseSchema,
    nextContentBatch: upcomingNotificationBatchResponseSchema.nullable(),
    blockers: z.array(z.string()),
    enabledChannels: z.array(notificationChannelSchema),
    upcomingDays: z.number().int().nonnegative(),
    latestJob: notificationHistoryJobResponseSchema.nullable(),
    latestFailedJob: notificationHistoryJobResponseSchema.nullable(),
  }).strict(),
  upcoming: z.array(upcomingNotificationBatchResponseSchema),
}).strict();
export const notificationOverviewResponseSchema = apiSuccessResponseSchema(notificationOverviewPayloadSchema);

export const notificationHistoryPayloadSchema = z.object({
  jobs: z.array(notificationHistoryJobResponseSchema),
  status: notificationHistoryStatusSchema,
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
}).strict();
export const notificationHistoryResponseSchema = apiSuccessResponseSchema(notificationHistoryPayloadSchema);

export const notificationsTestResponseSchema = okResponseSchema;
export const notificationRunSkippedPayloadSchema = z.object({
  sent: z.literal(false),
  reason: z.literal("no_due_items"),
}).strict();
export const notificationRunSentPayloadSchema = z.object({
  sent: z.literal(true),
  summary: jobChannelsResponseSchema,
}).strict();
export const notificationRunPayloadSchema = z.discriminatedUnion("sent", [
  notificationRunSkippedPayloadSchema,
  notificationRunSentPayloadSchema,
]);
export const notificationRunResponseSchema = apiSuccessResponseSchema(notificationRunPayloadSchema);

export type NotificationHistoryStatusFilter = z.infer<typeof notificationHistoryStatusSchema>;
export type NotificationHistoryJob = z.infer<typeof notificationHistoryJobResponseSchema>;
export type UpcomingNotificationBatch = z.infer<typeof upcomingNotificationBatchResponseSchema>;
export type NotificationOverviewResponse = z.infer<typeof notificationOverviewPayloadSchema>;
export type NotificationHistoryResponse = z.infer<typeof notificationHistoryPayloadSchema>;
export type NotificationJobResult = z.infer<typeof notificationJobResultResponseSchema>;
