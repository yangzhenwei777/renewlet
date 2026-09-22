import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import type { SubscriptionCollectionItem } from "@/types/subscription";
import { useSubscriptionCalendarDialog } from "./use-subscription-calendar-dialog";

const mocks = vi.hoisted(() => ({
  prefetchSubscriptionDetail: vi.fn(),
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  prefetchSubscriptionDetail: mocks.prefetchSubscriptionDetail,
  useSubscriptionDetail: (id: string | null) => ({
    data: undefined,
    error: null,
    isPending: id !== null,
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

function subscription(): SubscriptionCollectionItem {
  return {
    id: "sub_1",
    name: "First",
    logo: undefined,
    price: "10",
    currency: "USD",
    billingCycle: "monthly",
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
    reminderDays: -1,
  };
}

describe("useSubscriptionCalendarDialog", () => {
  it("keeps the intent preview when the collection changes during the dialog session", () => {
    const collectionItem = subscription();
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly SubscriptionCollectionItem[] }) => useSubscriptionCalendarDialog(items),
      {
        initialProps: { items: [collectionItem] },
        wrapper: createWrapper(),
      },
    );

    act(() => result.current.show(collectionItem.id));
    rerender({ items: [] });

    expect(result.current.open).toBe(true);
    expect(result.current.collectionItem).toBe(collectionItem);
    expect(result.current.pending).toBe(true);
  });
});
