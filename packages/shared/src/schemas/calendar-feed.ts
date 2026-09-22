import { z } from "zod";
import { SUBSCRIPTION_STATUSES } from "../runtime";
import { apiSuccessResponseSchema } from "./api";
import { okResponseSchema } from "./common";
import { dateInputSchema } from "./subscriptions";

/**
 * 登录态管理接口只返回可展示的 feed URL，不返回 token 字段本身。
 *
 * 公开 ICS route 使用 URL 中的 bearer token，误分享后的失效动作是撤销或原子轮换 feed。
 */
export const calendarFeedStatusSchema = z.object({
  enabled: z.boolean(),
  createdAt: z.string().optional(),
  feedUrl: z.string().trim().url().max(4096).optional(),
  updatedAt: z.string().optional(),
}).strict();

export const calendarFeedStatusPayloadSchema = z.object({
  calendarFeed: calendarFeedStatusSchema,
}).strict();
export const calendarFeedStatusResponseSchema = apiSuccessResponseSchema(calendarFeedStatusPayloadSchema);

/** 创建 feed 不接受客户端传 token，避免前端或导入工具把低权限 bearer secret 带入请求体。 */
export const calendarFeedCreateRequestSchema = z.object({}).strict();

export const calendarFeedCreatePayloadSchema = z.object({
  calendarFeed: z.object({
    enabled: z.literal(true),
    createdAt: z.string().trim().min(1),
    updatedAt: z.string().trim().min(1),
    feedUrl: z.string().trim().url().max(4096),
  }).strict(),
}).strict();
export const calendarFeedCreateResponseSchema = apiSuccessResponseSchema(calendarFeedCreatePayloadSchema);

/** 轮换只表达用户意图，token 必须由服务端原子替换，不能接受客户端候选值。 */
export const calendarFeedRotateRequestSchema = z.object({}).strict();
export const calendarFeedRotateResponseSchema = calendarFeedCreateResponseSchema;

const calendarFeedQueryIntegerSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  return /^[+-]?\d+$/.test(normalized) ? Number(normalized) : value;
}, z.number().int());

export const subscriptionCalendarFeedListQuerySchema = z.object({
  limit: calendarFeedQueryIntegerSchema.pipe(z.number().min(1).max(50)).default(20),
  offset: calendarFeedQueryIntegerSchema.pipe(z.number().nonnegative()).default(0),
}).strict();

export const subscriptionCalendarFeedListItemSchema = z.object({
  id: z.string().trim().min(1),
  createdAt: z.string().trim().min(1),
  feedUrl: z.string().trim().url().max(4096),
  updatedAt: z.string().trim().min(1),
  subscription: z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120),
    status: z.enum(SUBSCRIPTION_STATUSES),
    nextBillingDate: dateInputSchema,
  }).strict(),
}).strict();

export const subscriptionCalendarFeedListPayloadSchema = z.object({
  calendarFeeds: z.object({
    items: z.array(subscriptionCalendarFeedListItemSchema),
    limit: z.number().int().min(1).max(50),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  }).strict(),
}).strict();
export const subscriptionCalendarFeedListResponseSchema = apiSuccessResponseSchema(subscriptionCalendarFeedListPayloadSchema);

export const calendarFeedDeleteResponseSchema = okResponseSchema;

export type CalendarFeedStatus = z.infer<typeof calendarFeedStatusSchema>;
export type CalendarFeedStatusResponse = z.infer<typeof calendarFeedStatusPayloadSchema>;
export type CalendarFeedCreateRequest = z.infer<typeof calendarFeedCreateRequestSchema>;
export type CalendarFeedCreateResponse = z.infer<typeof calendarFeedCreatePayloadSchema>;
export type CalendarFeedRotateRequest = z.infer<typeof calendarFeedRotateRequestSchema>;
export type SubscriptionCalendarFeedListQuery = z.infer<typeof subscriptionCalendarFeedListQuerySchema>;
export type SubscriptionCalendarFeedListItem = z.infer<typeof subscriptionCalendarFeedListItemSchema>;
export type SubscriptionCalendarFeedListResponse = z.infer<typeof subscriptionCalendarFeedListPayloadSchema>;
