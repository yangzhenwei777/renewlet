import { describe, expect, it } from "vitest";
import {
  calendarFeedRotateRequestSchema,
  calendarFeedRotateResponseSchema,
  subscriptionCalendarFeedListPayloadSchema,
  subscriptionCalendarFeedListQuerySchema,
} from "./calendar-feed";

describe("calendar feed schemas", () => {
  it("parses bounded pagination defaults and rejects unsupported values", () => {
    expect(subscriptionCalendarFeedListQuerySchema.parse({})).toEqual({ limit: 20, offset: 0 });
    expect(subscriptionCalendarFeedListQuerySchema.parse({ limit: "50", offset: "40" })).toEqual({ limit: 50, offset: 40 });
    expect(subscriptionCalendarFeedListQuerySchema.safeParse({ limit: 51, offset: 0 }).success).toBe(false);
    expect(subscriptionCalendarFeedListQuerySchema.safeParse({ limit: "2e1", offset: 0 }).success).toBe(false);
    expect(subscriptionCalendarFeedListQuerySchema.safeParse({ limit: 20, offset: -1 }).success).toBe(false);
    expect(subscriptionCalendarFeedListQuerySchema.safeParse({ limit: 20, offset: 0, cursor: "legacy" }).success).toBe(false);
  });

  it("accepts only strict subscription feed list items", () => {
    const parsed = subscriptionCalendarFeedListPayloadSchema.parse({
      calendarFeeds: {
        items: [{
          id: "cal_sub",
          feedUrl: "https://renewlet.example/calendar/renewals.ics?token=sub",
          createdAt: "2026-08-19T00:00:00.000Z",
          updatedAt: "2026-08-19T00:00:00.000Z",
          subscription: {
            id: "sub_1",
            name: "Fastmail",
            status: "active",
            nextBillingDate: "2026-09-01",
          },
        }],
        limit: 20,
        offset: 0,
        total: 1,
        hasMore: false,
      },
    });
    expect(parsed.calendarFeeds.items[0]?.subscription.id).toBe("sub_1");
    expect(subscriptionCalendarFeedListPayloadSchema.safeParse({
      calendarFeeds: { ...parsed.calendarFeeds, items: [{ ...parsed.calendarFeeds.items[0], scope: "subscription" }] },
    }).success).toBe(false);
    expect(subscriptionCalendarFeedListPayloadSchema.safeParse({
      calendarFeeds: { ...parsed.calendarFeeds, items: [{ ...parsed.calendarFeeds.items[0], subscription: { id: "sub" } }] },
    }).success).toBe(false);
  });

  it("accepts only an empty rotate request and validates the rotated URL response", () => {
    expect(calendarFeedRotateRequestSchema.parse({})).toEqual({});
    expect(calendarFeedRotateRequestSchema.safeParse({ token: "client-token" }).success).toBe(false);
    expect(calendarFeedRotateResponseSchema.safeParse({
      ok: true,
      data: {
        calendarFeed: {
          enabled: true,
          createdAt: "2026-08-20T00:00:00.000Z",
          updatedAt: "2026-08-20T00:01:00.000Z",
          feedUrl: "https://renewlet.example/calendar/renewals.ics?token=rotated",
        },
      },
    }).success).toBe(true);
  });
});
