import { describe, expect, it } from "vitest";
import { readSuccessData } from "./api-test-helpers";
import {
  calendarFeedIcs,
  deleteCalendarFeed,
  deleteSubscriptionCalendarFeed,
  listSubscriptionCalendarFeeds,
  rotateCalendarFeed,
  rotateSubscriptionCalendarFeed,
} from "./calendar-feed";
import {
  authorizedCalendarFeedRequest,
  calendarFeedRow,
  CALENDAR_FEED_TEST_USER_ID,
  createCalendarFeedTestEnv,
  subscriptionRow,
} from "./calendar-feed-test-env";

interface SubscriptionCalendarFeedListData {
  calendarFeeds: {
    items: Array<{
      id: string;
      feedUrl: string;
      subscription: { id: string; name: string };
    }>;
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
  };
}

describe("calendar feed management worker handlers", () => {
  it("lists only owner subscription feeds with stable pagination in one joined query", async () => {
    const env = await createCalendarFeedTestEnv({
      feeds: [
        calendarFeedRow({ id: "cal-global", token: "global", updated_at: "2026-08-01T00:00:00.000Z" }),
        calendarFeedRow({
          id: "cal-sub-z",
          scope: "subscription",
          subscription_id: "sub_active",
          token: "sub-new",
          updated_at: "2026-08-20T00:00:00.000Z",
        }),
        calendarFeedRow({
          id: "cal-sub-a",
          scope: "subscription",
          subscription_id: "sub_paused",
          token: "sub-old",
          updated_at: "2026-08-20T00:00:00.000Z",
        }),
        calendarFeedRow({
          id: "cal-orphan",
          scope: "subscription",
          subscription_id: "sub-missing",
          token: "orphan",
        }),
        calendarFeedRow({ id: "cal-other", user_id: "usr-other", token: "other" }),
      ],
    });

    const firstResponse = await listSubscriptionCalendarFeeds(authorizedCalendarFeedRequest(
      "https://renewlet.example/api/app/subscriptions/calendar-feeds?limit=1&offset=0",
    ), env);
    const first = await readSuccessData<SubscriptionCalendarFeedListData>(firstResponse);

    expect(firstResponse.headers.get("cache-control")).toBe("no-store");
    expect(first.calendarFeeds.items.map((item) => item.id)).toEqual(["cal-sub-z"]);
    expect(first.calendarFeeds.items[0]?.subscription).toMatchObject({ id: "sub_active", name: "Active Plan" });
    expect(first.calendarFeeds.items[0]).not.toHaveProperty("scope");
    expect(first.calendarFeeds).toMatchObject({ limit: 1, offset: 0, total: 2, hasMore: true });
    expect(env.__state.listQueryCount).toBe(1);

    const second = await readSuccessData<SubscriptionCalendarFeedListData>(await listSubscriptionCalendarFeeds(authorizedCalendarFeedRequest(
      "https://renewlet.example/api/app/subscriptions/calendar-feeds?limit=1&offset=1",
    ), env));
    expect(second.calendarFeeds.items.map((item) => item.id)).toEqual(["cal-sub-a"]);
    expect(second.calendarFeeds).toMatchObject({ total: 2, hasMore: false });

    const empty = await readSuccessData<SubscriptionCalendarFeedListData>(await listSubscriptionCalendarFeeds(authorizedCalendarFeedRequest(
      "https://renewlet.example/api/app/subscriptions/calendar-feeds?limit=2&offset=99",
    ), env));
    expect(empty.calendarFeeds.items).toEqual([]);
    expect(empty.calendarFeeds.total).toBe(2);
    expect(env.__state.listQueryCount).toBe(3);
  });

  it("rejects invalid pagination without reading the management list", async () => {
    const env = await createCalendarFeedTestEnv();

    await expect(listSubscriptionCalendarFeeds(authorizedCalendarFeedRequest(
      "https://renewlet.example/api/app/subscriptions/calendar-feeds?limit=51&offset=0",
    ), env)).rejects.toMatchObject({ status: 400 });
    await expect(listSubscriptionCalendarFeeds(authorizedCalendarFeedRequest(
      "https://renewlet.example/api/app/subscriptions/calendar-feeds?limit=2e1&offset=0",
    ), env)).rejects.toMatchObject({ status: 400 });
    await expect(listSubscriptionCalendarFeeds(authorizedCalendarFeedRequest(
      "https://renewlet.example/api/app/subscriptions/calendar-feeds?limit=20&limit=10&offset=0",
    ), env)).rejects.toMatchObject({ status: 400 });
    await expect(listSubscriptionCalendarFeeds(authorizedCalendarFeedRequest(
      "https://renewlet.example/api/app/subscriptions/calendar-feeds?limit=20&offset=0&cursor=legacy",
    ), env)).rejects.toMatchObject({ status: 400 });
    expect(env.__state.listQueryCount).toBe(0);
  });

  it("rotates a subscription token atomically and invalidates the old public URL", async () => {
    const env = await createCalendarFeedTestEnv({
      feeds: [calendarFeedRow({
        id: "cal-sub",
        scope: "subscription",
        subscription_id: "sub_active",
        token: "old-token",
      })],
    });
    const oldUrl = "https://renewlet.example/calendar/renewals.ics?token=old-token";
    const response = await rotateSubscriptionCalendarFeed(authorizedCalendarFeedRequest(
      "https://renewlet.example/api/app/subscriptions/sub_active/calendar-feed/rotate",
      { body: "{}", method: "POST" },
    ), env, "sub_active");
    const rotated = await readSuccessData<{ calendarFeed: { feedUrl: string } }>(response);

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(rotated.calendarFeed.feedUrl).not.toBe(oldUrl);
    expect(env.__state.feeds[0]?.id).toBe("cal-sub");
    await expect(calendarFeedIcs(new Request(oldUrl), env)).rejects.toMatchObject({ status: 404 });
    expect((await calendarFeedIcs(new Request(rotated.calendarFeed.feedUrl), env)).status).toBe(200);
  });

  it("keeps the old token valid when rotation fails and rejects non-empty bodies", async () => {
    const oldFeed = calendarFeedRow({ token: "old-token" });
    const env = await createCalendarFeedTestEnv({ feeds: [oldFeed] });

    await expect(rotateCalendarFeed(authorizedCalendarFeedRequest(
      "https://renewlet.example/api/app/calendar-feed/rotate",
      { body: '{"token":"client-value"}', method: "POST" },
    ), env)).rejects.toMatchObject({ status: 400 });
    expect(env.__state.feeds[0]?.token).toBe("old-token");

    env.__state.calendarFeedMutationError = new Error("D1 write failed");
    await expect(rotateCalendarFeed(authorizedCalendarFeedRequest(
      "https://renewlet.example/api/app/calendar-feed/rotate",
      { body: "{}", method: "POST" },
    ), env)).rejects.toThrow("D1 write failed");
    expect(env.__state.feeds[0]?.token).toBe("old-token");
    expect((await calendarFeedIcs(new Request(
      "https://renewlet.example/calendar/renewals.ics?token=old-token",
    ), env)).status).toBe(200);
  });

  it("returns owner-scoped 404 for missing rotate and revoke targets", async () => {
    const env = await createCalendarFeedTestEnv({
      feeds: [calendarFeedRow({ user_id: "usr-other", token: "other-token" })],
      subscriptions: [
        subscriptionRow("sub_active", "Active Plan", "active", "monthly", "2099-06-02"),
        subscriptionRow("sub_other", "Other Plan", "active", "monthly", "2099-06-03", { user_id: "usr-other" }),
      ],
    });

    await expect(rotateCalendarFeed(authorizedCalendarFeedRequest(
      "https://renewlet.example/api/app/calendar-feed/rotate",
      { body: "{}", method: "POST" },
    ), env)).rejects.toMatchObject({ status: 404 });
    await expect(rotateSubscriptionCalendarFeed(authorizedCalendarFeedRequest(
      "https://renewlet.example/api/app/subscriptions/sub_other/calendar-feed/rotate",
      { body: "{}", method: "POST" },
    ), env, "sub_other")).rejects.toMatchObject({ status: 404 });
    await expect(deleteCalendarFeed(authorizedCalendarFeedRequest(
      "https://renewlet.example/api/app/calendar-feed",
      { method: "DELETE" },
    ), env)).rejects.toMatchObject({ status: 404 });
    await expect(deleteSubscriptionCalendarFeed(authorizedCalendarFeedRequest(
      "https://renewlet.example/api/app/subscriptions/sub_active/calendar-feed",
      { method: "DELETE" },
    ), env, "sub_active")).rejects.toMatchObject({ status: 404 });
    expect(env.__state.feeds).toHaveLength(1);
    expect(env.__state.feeds[0]?.user_id).not.toBe(CALENDAR_FEED_TEST_USER_ID);
  });

  it("sets no-store on successful revoke responses", async () => {
    const env = await createCalendarFeedTestEnv({ feeds: [calendarFeedRow()] });
    const response = await deleteCalendarFeed(authorizedCalendarFeedRequest(
      "https://renewlet.example/api/app/calendar-feed",
      { method: "DELETE" },
    ), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(env.__state.feeds).toEqual([]);
  });
});
