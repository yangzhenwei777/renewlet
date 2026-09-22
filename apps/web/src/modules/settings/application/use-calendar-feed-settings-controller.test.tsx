import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import { useCalendarFeedSettingsController } from "./use-calendar-feed-settings-controller";

type AppToast = (typeof import("@/components/ui/sonner"))["toast"];

const mocks = vi.hoisted(() => ({
  copyText: vi.fn(),
  create: { isPending: false, variables: undefined as unknown, mutateAsync: vi.fn() },
  delete: { isPending: false, variables: undefined as unknown, mutateAsync: vi.fn() },
  globalFeed: {
    data: undefined as unknown,
    error: null as unknown,
    isPending: false,
    isRefetching: false,
    refetch: vi.fn(),
  },
  subscriptionFeeds: {
    data: undefined as unknown,
    error: null as unknown,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    isPending: false,
    isRefetching: false,
    refetch: vi.fn(),
  },
  openSystem: vi.fn(),
  rotate: { isPending: false, variables: undefined as unknown, mutateAsync: vi.fn() },
  toast: {
    success: vi.fn<AppToast["success"]>(),
    error: vi.fn<AppToast["error"]>(),
  },
}));

vi.mock("@/hooks/use-calendar-feed", () => ({
  useCalendarFeedStatus: () => mocks.globalFeed,
  useCreateCalendarFeed: () => mocks.create,
  useDeleteCalendarFeed: () => mocks.delete,
  useRotateCalendarFeed: () => mocks.rotate,
  useSubscriptionCalendarFeeds: () => mocks.subscriptionFeeds,
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: mocks.toast,
}));

vi.mock("@/shared/browser/calendar-links", () => ({
  openValidatedWebcalUrl: mocks.openSystem,
}));

vi.mock("@/shared/browser/clipboard", () => ({
  copyTextToClipboard: mocks.copyText,
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const globalFeed = {
  enabled: true as const,
  feedUrl: "https://example.com/calendar/renewals.ics?token=all",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const subscriptionFeed = {
  id: "cal-sub",
  feedUrl: "https://example.com/calendar/renewals.ics?token=sub",
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
  subscription: {
    id: "sub-1",
    name: "Fastmail",
    status: "active" as const,
    nextBillingDate: assertDateOnly("2026-09-01"),
  },
};

const olderSubscriptionFeed = {
  ...subscriptionFeed,
  id: "cal-sub-2",
  feedUrl: "https://example.com/calendar/renewals.ics?token=sub-2",
  subscription: { ...subscriptionFeed.subscription, id: "sub-2", name: "GitHub" },
};

describe("useCalendarFeedSettingsController", () => {
  beforeEach(() => {
    mocks.copyText.mockReset().mockResolvedValue({ ok: true, method: "clipboard" });
    mocks.openSystem.mockReset().mockResolvedValue(undefined);
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
    for (const mutation of [mocks.create, mocks.rotate, mocks.delete]) {
      mutation.isPending = false;
      mutation.variables = undefined;
      mutation.mutateAsync.mockReset().mockResolvedValue(globalFeed);
    }
    Object.assign(mocks.globalFeed, {
      data: globalFeed,
      error: null,
      isPending: false,
      isRefetching: false,
    });
    Object.assign(mocks.subscriptionFeeds, {
      data: {
        pages: [{ items: [subscriptionFeed], limit: 1, offset: 0, total: 2, hasMore: true }, {
          items: [olderSubscriptionFeed], limit: 1, offset: 1, total: 2, hasMore: false,
        }],
      },
      error: null,
      hasNextPage: true,
      isFetchingNextPage: false,
      isPending: false,
      isRefetching: false,
    });
    mocks.globalFeed.refetch.mockReset().mockResolvedValue(undefined);
    mocks.subscriptionFeeds.fetchNextPage.mockReset().mockResolvedValue(undefined);
    mocks.subscriptionFeeds.refetch.mockReset().mockResolvedValue(undefined);
  });

  it("flattens paged items and only requests another page on explicit intent", async () => {
    const { result } = renderHook(() => useCalendarFeedSettingsController());

    expect(result.current.global.data).toEqual(globalFeed);
    expect(result.current.subscriptions.data?.items).toEqual([subscriptionFeed, olderSubscriptionFeed]);
    expect(result.current.subscriptions.data?.total).toBe(2);
    expect(result.current.subscriptions.hasData).toBe(true);
    expect(result.current.subscriptions.data?.hasMore).toBe(true);
    expect(mocks.subscriptionFeeds.fetchNextPage).not.toHaveBeenCalled();

    await act(async () => result.current.subscriptions.loadMore());
    expect(mocks.subscriptionFeeds.fetchNextPage).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.global.retry();
      await result.current.subscriptions.retry();
    });
    expect(mocks.globalFeed.refetch).toHaveBeenCalledTimes(1);
    expect(mocks.subscriptionFeeds.refetch).toHaveBeenCalledTimes(1);
  });

  it("keeps global and subscription read failures independent", () => {
    mocks.globalFeed.error = new Error("global failed");
    mocks.globalFeed.data = undefined;
    mocks.subscriptionFeeds.error = new Error("list failed");
    const { result } = renderHook(() => useCalendarFeedSettingsController());

    expect(result.current.global.error?.message).toBe("global failed");
    expect(result.current.global.hasData).toBe(false);
    expect(result.current.subscriptions.error?.message).toBe("list failed");
    expect(result.current.subscriptions.data?.items).toHaveLength(2);
  });

  it("routes create, rotate, and revoke through the same target contract", async () => {
    const target = { scope: "subscription" as const, subscriptionId: "sub-1" };
    const { result } = renderHook(() => useCalendarFeedSettingsController());

    await act(async () => {
      expect(await result.current.create(target)).toBe(true);
      expect(await result.current.rotate(target)).toBe(true);
      expect(await result.current.revoke(target)).toBe(true);
    });

    expect(mocks.create.mutateAsync).toHaveBeenCalledWith(target);
    expect(mocks.rotate.mutateAsync).toHaveBeenCalledWith(target);
    expect(mocks.delete.mutateAsync).toHaveBeenCalledWith(target);
    expect(mocks.toast.success).toHaveBeenNthCalledWith(1, "settings.calendarFeedGenerated");
    expect(mocks.toast.success).toHaveBeenNthCalledWith(2, "settings.calendarFeedRegenerated");
    expect(mocks.toast.success).toHaveBeenNthCalledWith(3, "settings.calendarFeedRevoked");
  });

  it("exposes pending state for only the active target and keeps failures recoverable", async () => {
    const target = { scope: "subscription" as const, subscriptionId: "sub-1" };
    mocks.rotate.isPending = true;
    mocks.rotate.variables = target;
    mocks.delete.mutateAsync.mockRejectedValueOnce(new Error("revoke failed"));
    const { result } = renderHook(() => useCalendarFeedSettingsController());

    expect(result.current.pendingTargetKey).toBe("subscription:sub-1");
    expect(result.current.pendingKind).toBe("rotate");

    await act(async () => {
      expect(await result.current.revoke(target)).toBe(false);
    });
    expect(mocks.toast.error).toHaveBeenLastCalledWith("settings.calendarFeedRevokeFailed", {
      description: "revoke failed",
    });
  });

  it("uses action-specific failure titles while preserving real errors", async () => {
    const target = { scope: "subscription" as const, subscriptionId: "sub-1" };
    mocks.create.mutateAsync.mockRejectedValueOnce(new Error("create failed"));
    mocks.rotate.mutateAsync.mockRejectedValueOnce(new Error("rotate failed"));
    mocks.delete.mutateAsync.mockRejectedValueOnce(new Error("revoke failed"));
    const { result } = renderHook(() => useCalendarFeedSettingsController());

    await act(async () => {
      expect(await result.current.create(target)).toBe(false);
      expect(await result.current.rotate(target)).toBe(false);
      expect(await result.current.revoke(target)).toBe(false);
    });

    expect(mocks.toast.error).toHaveBeenNthCalledWith(1, "settings.calendarFeedCreateFailed", {
      description: "create failed",
    });
    expect(mocks.toast.error).toHaveBeenNthCalledWith(2, "settings.calendarFeedRotateFailed", {
      description: "rotate failed",
    });
    expect(mocks.toast.error).toHaveBeenNthCalledWith(3, "settings.calendarFeedRevokeFailed", {
      description: "revoke failed",
    });
  });

  it("uses shared clipboard and system-calendar boundaries with concise feedback", async () => {
    const input = document.createElement("input");
    const { result } = renderHook(() => useCalendarFeedSettingsController());

    await act(async () => {
      await result.current.copyUrl(globalFeed.feedUrl, input);
    });
    expect(mocks.copyText).toHaveBeenCalledWith(globalFeed.feedUrl, { target: input });
    expect(mocks.toast.success).toHaveBeenLastCalledWith("settings.calendarFeedCopied");

    await act(async () => {
      await result.current.openSystem(globalFeed.feedUrl);
    });
    expect(mocks.openSystem).toHaveBeenCalledWith(globalFeed.feedUrl);
    expect(mocks.toast.success).toHaveBeenLastCalledWith("settings.calendarFeedOpenSystemResult");
  });

  it("keeps manual recovery paths for browser-bound failures", async () => {
    mocks.copyText.mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
      error: new Error("clipboard unavailable"),
    });
    mocks.openSystem.mockRejectedValueOnce(new Error("calendar validation failed"));
    const { result } = renderHook(() => useCalendarFeedSettingsController());

    await act(async () => {
      await result.current.copyUrl(globalFeed.feedUrl);
    });
    expect(mocks.toast.error).toHaveBeenLastCalledWith("settings.calendarFeedCopyFailed", {
      description: "settings.calendarFeedCopyFailedDescription",
    });

    await act(async () => {
      await result.current.openSystem(globalFeed.feedUrl);
    });
    expect(mocks.toast.error).toHaveBeenLastCalledWith("settings.calendarFeedOpenSystemFailed", {
      description: "settings.calendarFeedOpenSystemFailedDescription",
    });
  });
});
