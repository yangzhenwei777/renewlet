import { describe, expect, it, vi } from "vitest";
import { toSettingsReadState } from "./settings-read-state";

describe("toSettingsReadState", () => {
  it("marks a query without data as initially loading", () => {
    const state = toSettingsReadState({
      data: undefined,
      error: null,
      isFetched: false,
      isPending: true,
      isFetching: true,
      refetch: vi.fn(),
    });

    expect(state).toMatchObject({
      data: undefined,
      hasData: false,
      error: null,
      isInitialLoading: true,
      isRefreshing: false,
    });
  });

  it("keeps cached data available while a refresh is pending or has failed", () => {
    const data = [{ id: "cached" }];
    const error = new Error("refresh failed");
    const state = toSettingsReadState({
      data,
      error,
      isFetched: true,
      isPending: false,
      isFetching: true,
      refetch: vi.fn(),
    });

    expect(state).toMatchObject({
      data,
      hasData: true,
      error,
      isInitialLoading: false,
      isRefreshing: true,
    });
  });

  it("marks a retry after the first failure as refreshing without inventing cached data", () => {
    const error = new Error("initial load failed");
    const state = toSettingsReadState({
      data: undefined,
      error,
      isFetched: true,
      isPending: true,
      isFetching: true,
      refetch: vi.fn(),
    });

    expect(state).toMatchObject({
      data: undefined,
      hasData: false,
      error,
      isInitialLoading: false,
      isRefreshing: true,
    });
  });

  it("normalizes non-Error failures and delegates retry to refetch", async () => {
    const refetch = vi.fn().mockResolvedValue({ data: "fresh" });
    const state = toSettingsReadState({
      data: undefined,
      error: "failed",
      isFetched: true,
      isPending: false,
      isFetching: false,
      refetch,
    });

    expect(state.error).toEqual(new Error("Settings read failed"));
    await state.retry();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
