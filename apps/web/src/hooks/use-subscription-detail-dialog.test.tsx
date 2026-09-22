import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import type { Subscription, SubscriptionCollectionItem } from "@/types/subscription";
import { useSubscriptionDetailDialog } from "./use-subscription-detail-dialog";

const mocks = vi.hoisted(() => ({
  details: new Map<string, Subscription>(),
  prefetchSubscriptionDetail: vi.fn(),
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  prefetchSubscriptionDetail: mocks.prefetchSubscriptionDetail,
  useSubscriptionDetail: (id: string | null) => ({
    data: id !== null ? mocks.details.get(id) : undefined,
    error: null,
    isPending: id !== null && !mocks.details.has(id),
  }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function subscription(id: string, name: string): Subscription {
  return {
    id,
    name,
    logo: undefined,
    price: "10",
    currency: "USD",
    billingCycle: "monthly",
    customDays: undefined,
    customCycleUnit: undefined,
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-01-01"),
    nextBillingDate: assertDateOnly("2026-02-01"),
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    trialEndDate: undefined,
    website: undefined,
    notes: undefined,
    tags: [],
    reminderDays: -1,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {},
  };
}

describe("useSubscriptionDetailDialog", () => {
  beforeEach(() => {
    mocks.details.clear();
    mocks.prefetchSubscriptionDetail.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the selected subscription until the close animation cleanup runs", () => {
    vi.useFakeTimers();
    const first = subscription("sub_1", "First");
    mocks.details.set(first.id, first);
    const { result } = renderHook(() => useSubscriptionDetailDialog([first]), { wrapper: createWrapper() });

    act(() => result.current.handleViewDetails("sub_1"));
    expect(result.current.detailDialogOpen).toBe(true);
    expect(result.current.selectedDetailSubscription?.name).toBe("First");
    expect(result.current.selectedDetailCollectionItem?.name).toBe("First");

    act(() => result.current.handleDetailDialogOpenChange(false));
    expect(result.current.detailDialogOpen).toBe(false);
    expect(result.current.selectedDetailSubscription?.name).toBe("First");
    expect(result.current.selectedDetailCollectionItem?.name).toBe("First");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.selectedDetailSubscription).toBeNull();
    expect(result.current.selectedDetailCollectionItem).toBeNull();
  });

  it("cancels pending cleanup when another detail dialog opens", () => {
    vi.useFakeTimers();
    const first = subscription("sub_1", "First");
    const second = subscription("sub_2", "Second");
    mocks.details.set(first.id, first);
    mocks.details.set(second.id, second);
    const { result } = renderHook(() => useSubscriptionDetailDialog([first, second]), { wrapper: createWrapper() });

    act(() => result.current.handleViewDetails("sub_1"));
    act(() => result.current.handleDetailDialogOpenChange(false));
    act(() => result.current.handleViewDetails("sub_2"));
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.detailDialogOpen).toBe(true);
    expect(result.current.selectedDetailSubscription?.name).toBe("Second");
    expect(result.current.selectedDetailCollectionItem?.name).toBe("Second");
  });

  it("keeps the intent preview when the collection changes during the dialog session", () => {
    const first = subscription("sub_1", "First");
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly SubscriptionCollectionItem[] }) => useSubscriptionDetailDialog(items),
      {
        initialProps: { items: [first] },
        wrapper: createWrapper(),
      },
    );

    act(() => result.current.handleViewDetails(first.id));
    rerender({ items: [] });

    expect(result.current.selectedDetailCollectionItem).toBe(first);
  });
});
