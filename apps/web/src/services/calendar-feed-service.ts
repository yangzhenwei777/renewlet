import { apiFetch, apiFetchBlob } from "@/lib/api-client";
import {
  calendarFeedCreateResponseSchema,
  calendarFeedDeleteResponseSchema,
  calendarFeedRotateResponseSchema,
  calendarFeedStatusResponseSchema,
  subscriptionCalendarFeedListResponseSchema,
  type CalendarFeedCreateResponse,
  type CalendarFeedStatusResponse,
  type SubscriptionCalendarFeedListQuery,
  type SubscriptionCalendarFeedListResponse,
} from "@/lib/api/schemas/calendar-feed";

export type CalendarFeedTarget =
  | { scope: "all" }
  | { scope: "subscription"; subscriptionId: string };

export function calendarFeedTargetKey(target: CalendarFeedTarget): string {
  return target.scope === "all" ? "all" : `subscription:${target.subscriptionId}`;
}

function calendarFeedTargetPath(target: CalendarFeedTarget): string {
  return target.scope === "all"
    ? "/api/app/calendar-feed"
    : `/api/app/subscriptions/${encodeURIComponent(target.subscriptionId)}/calendar-feed`;
}

/** 登录态管理只传 scope/订阅 ID；bearer token 永远由服务端生成并仅以完整 URL 返回。 */
export const calendarFeedService = {
  async get(target: CalendarFeedTarget, signal?: AbortSignal): Promise<CalendarFeedStatusResponse["calendarFeed"]> {
    const data = await apiFetch(
      calendarFeedTargetPath(target),
      calendarFeedStatusResponseSchema,
      signal ? { signal } : undefined,
    );
    return data.calendarFeed;
  },

  async listSubscriptions(
    query: SubscriptionCalendarFeedListQuery,
    signal?: AbortSignal,
  ): Promise<SubscriptionCalendarFeedListResponse["calendarFeeds"]> {
    const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) });
    const data = await apiFetch(
      `/api/app/subscriptions/calendar-feeds?${params}`,
      subscriptionCalendarFeedListResponseSchema,
      signal ? { signal } : undefined,
    );
    return data.calendarFeeds;
  },

  async create(target: CalendarFeedTarget): Promise<CalendarFeedCreateResponse["calendarFeed"]> {
    const data = await apiFetch(calendarFeedTargetPath(target), calendarFeedCreateResponseSchema, {
      method: "POST",
      body: JSON.stringify({}),
    });
    return data.calendarFeed;
  },

  async rotate(target: CalendarFeedTarget): Promise<CalendarFeedCreateResponse["calendarFeed"]> {
    const data = await apiFetch(`${calendarFeedTargetPath(target)}/rotate`, calendarFeedRotateResponseSchema, {
      method: "POST",
      body: JSON.stringify({}),
    });
    return data.calendarFeed;
  },

  async delete(target: CalendarFeedTarget): Promise<void> {
    await apiFetch(calendarFeedTargetPath(target), calendarFeedDeleteResponseSchema, { method: "DELETE" });
  },

  async downloadSubscriptionIcs(subscriptionId: string): Promise<Blob> {
    return await apiFetchBlob(`/api/app/subscriptions/${encodeURIComponent(subscriptionId)}/calendar.ics`);
  },
};
