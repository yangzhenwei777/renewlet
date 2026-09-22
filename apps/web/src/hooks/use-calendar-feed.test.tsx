import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCalendarFeedQueries } from "./calendar-feed-query-cache";
import {
  calendarFeedQueryKeys,
  useCreateCalendarFeed,
  useDeleteCalendarFeed,
  useRotateCalendarFeed,
  useSubscriptionCalendarFeeds,
} from "./use-calendar-feed";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  listSubscriptions: vi.fn(),
  rotate: vi.fn(),
}));

vi.mock("@/services/calendar-feed-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/calendar-feed-service")>();
  return {
    ...actual,
    calendarFeedService: {
      ...actual.calendarFeedService,
      create: mocks.create,
      delete: mocks.delete,
      listSubscriptions: mocks.listSubscriptions,
      rotate: mocks.rotate,
    },
  };
});

const target = { scope: "subscription" as const, subscriptionId: "sub-1" };
const createdFeed = {
  enabled: true as const,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  feedUrl: "https://example.com/calendar/renewals.ics?token=created",
};

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe("calendar feed query cache", () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue(createdFeed);
    mocks.delete.mockReset().mockResolvedValue(undefined);
    mocks.listSubscriptions.mockReset();
    mocks.rotate.mockReset().mockResolvedValue({ ...createdFeed, feedUrl: "https://example.com/calendar/renewals.ics?token=rotated" });
  });

  it("converges subscription target state and invalidates only the subscription list", async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(calendarFeedQueryKeys.subscriptionLists(), { pages: [], pageParams: [] });
    const { result } = renderHook(() => ({
      create: useCreateCalendarFeed(),
      rotate: useRotateCalendarFeed(),
      revoke: useDeleteCalendarFeed(),
    }), { wrapper });

    await act(async () => result.current.create.mutateAsync(target));
    expect(queryClient.getQueryData(calendarFeedQueryKeys.target(target))).toEqual(createdFeed);
    expect(queryClient.getQueryState(calendarFeedQueryKeys.subscriptionLists())?.isInvalidated).toBe(true);

    queryClient.setQueryData(calendarFeedQueryKeys.subscriptionLists(), { pages: [], pageParams: [] });
    await act(async () => result.current.rotate.mutateAsync(target));
    expect(queryClient.getQueryData(calendarFeedQueryKeys.target(target))).toMatchObject({
      enabled: true,
      feedUrl: "https://example.com/calendar/renewals.ics?token=rotated",
    });
    expect(queryClient.getQueryState(calendarFeedQueryKeys.subscriptionLists())?.isInvalidated).toBe(true);

    queryClient.setQueryData(calendarFeedQueryKeys.subscriptionLists(), { pages: [], pageParams: [] });
    await act(async () => result.current.revoke.mutateAsync(target));
    expect(queryClient.getQueryData(calendarFeedQueryKeys.target(target))).toEqual({ enabled: false });
    expect(queryClient.getQueryState(calendarFeedQueryKeys.subscriptionLists())?.isInvalidated).toBe(true);
  });

  it("does not invalidate subscription pagination after a global feed mutation", async () => {
    const globalTarget = { scope: "all" as const };
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(calendarFeedQueryKeys.subscriptionLists(), { pages: [], pageParams: [] });
    const { result } = renderHook(() => useCreateCalendarFeed(), { wrapper });

    await act(async () => result.current.mutateAsync(globalTarget));

    expect(queryClient.getQueryData(calendarFeedQueryKeys.target(globalTarget))).toEqual(createdFeed);
    expect(queryClient.getQueryState(calendarFeedQueryKeys.subscriptionLists())?.isInvalidated).toBe(false);
  });

  it("removes every bearer URL cache when the authenticated identity changes", () => {
    const { queryClient } = setup();
    queryClient.setQueryData(calendarFeedQueryKeys.subscriptionLists(), {
      pages: [{ items: [], limit: 20, offset: 0, total: 0, hasMore: false }],
      pageParams: [0],
    });
    queryClient.setQueryData(calendarFeedQueryKeys.target(target), createdFeed);

    clearCalendarFeedQueries(queryClient);

    expect(queryClient.getQueryData(calendarFeedQueryKeys.subscriptionLists())).toBeUndefined();
    expect(queryClient.getQueryData(calendarFeedQueryKeys.target(target))).toBeUndefined();
  });

  it("loads only the first management page until fetchNextPage is requested", async () => {
    mocks.listSubscriptions
      .mockResolvedValueOnce({ items: [], limit: 20, offset: 0, total: 21, hasMore: true })
      .mockResolvedValueOnce({ items: [], limit: 20, offset: 20, total: 21, hasMore: false });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSubscriptionCalendarFeeds(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.listSubscriptions).toHaveBeenCalledTimes(1);
    expect(mocks.listSubscriptions.mock.calls[0]?.[0]).toEqual({ limit: 20, offset: 0 });

    await act(async () => result.current.fetchNextPage());
    expect(mocks.listSubscriptions).toHaveBeenCalledTimes(2);
    expect(mocks.listSubscriptions.mock.calls[1]?.[0]).toEqual({ limit: 20, offset: 20 });
  });
});
