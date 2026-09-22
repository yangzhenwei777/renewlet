import { beforeEach, describe, expect, it, vi } from "vitest";
import { calendarFeedService, calendarFeedTargetKey } from "./calendar-feed-service";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiFetchBlob: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: mocks.apiFetch,
  apiFetchBlob: mocks.apiFetchBlob,
}));

const calendarFeed = {
  enabled: true,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  feedUrl: "https://example.com/calendar/renewals.ics?token=secret",
};

describe("calendarFeedService", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset().mockResolvedValue({ calendarFeed });
    mocks.apiFetchBlob.mockReset().mockResolvedValue(new Blob());
  });

  it("builds stable target keys and encoded subscription routes", async () => {
    const globalTarget = { scope: "all" as const };
    const subscriptionTarget = { scope: "subscription" as const, subscriptionId: "sub/with space" };

    expect(calendarFeedTargetKey(globalTarget)).toBe("all");
    expect(calendarFeedTargetKey(subscriptionTarget)).toBe("subscription:sub/with space");

    await calendarFeedService.get(globalTarget);
    expect(mocks.apiFetch).toHaveBeenLastCalledWith(
      "/api/app/calendar-feed",
      expect.anything(),
      undefined,
    );

    await calendarFeedService.get(subscriptionTarget);
    expect(mocks.apiFetch).toHaveBeenLastCalledWith(
      "/api/app/subscriptions/sub%2Fwith%20space/calendar-feed",
      expect.anything(),
      undefined,
    );
  });

  it("uses strict empty bodies for create and atomic rotate routes", async () => {
    const target = { scope: "subscription" as const, subscriptionId: "sub-1" };

    await calendarFeedService.create(target);
    expect(mocks.apiFetch).toHaveBeenLastCalledWith(
      "/api/app/subscriptions/sub-1/calendar-feed",
      expect.anything(),
      { method: "POST", body: "{}" },
    );

    await calendarFeedService.rotate(target);
    expect(mocks.apiFetch).toHaveBeenLastCalledWith(
      "/api/app/subscriptions/sub-1/calendar-feed/rotate",
      expect.anything(),
      { method: "POST", body: "{}" },
    );

    await calendarFeedService.delete(target);
    expect(mocks.apiFetch).toHaveBeenLastCalledWith(
      "/api/app/subscriptions/sub-1/calendar-feed",
      expect.anything(),
      { method: "DELETE" },
    );
  });

  it("keeps management pagination and one-time ICS on independent endpoints", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      calendarFeeds: { items: [], limit: 20, offset: 40, total: 40, hasMore: false },
    });

    await calendarFeedService.listSubscriptions({ limit: 20, offset: 40 });
    expect(mocks.apiFetch).toHaveBeenLastCalledWith(
      "/api/app/subscriptions/calendar-feeds?limit=20&offset=40",
      expect.anything(),
      undefined,
    );

    await calendarFeedService.downloadSubscriptionIcs("sub/one");
    expect(mocks.apiFetchBlob).toHaveBeenCalledWith("/api/app/subscriptions/sub%2Fone/calendar.ics");
  });
});
