import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { millisecondsUntilNextZonedDay, useZonedToday } from "./use-zoned-today";

afterEach(() => {
  vi.useRealTimers();
});

describe("useZonedToday", () => {
  it("schedules against the next local midnight", () => {
    const now = new Date("2026-03-08T04:30:00.000Z");
    expect(millisecondsUntilNextZonedDay(now, "America/New_York")).toBe(30 * 60 * 1000);
  });

  it("uses calendar-day boundaries across 23-hour and 25-hour days", () => {
    expect(millisecondsUntilNextZonedDay(
      new Date("2026-03-08T05:00:00.000Z"),
      "America/New_York",
    )).toBe(23 * 60 * 60 * 1000);
    expect(millisecondsUntilNextZonedDay(
      new Date("2026-11-01T04:00:00.000Z"),
      "America/New_York",
    )).toBe(25 * 60 * 60 * 1000);
  });

  it("uses the first valid local time when midnight is skipped", () => {
    const beforeSkippedMidnight = new Date("2026-09-06T03:30:00.000Z");
    expect(millisecondsUntilNextZonedDay(beforeSkippedMidnight, "America/Santiago")).toBe(30 * 60 * 1000);
  });

  it("updates at local midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T15:59:59.000Z"));
    const { result } = renderHook(() => useZonedToday("Asia/Shanghai"));

    expect(result.current).toBe("2026-08-31");
    act(() => vi.advanceTimersByTime(1_050));
    expect(result.current).toBe("2026-09-01");
  });

  it("rechecks the date when a hidden tab becomes visible", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    const { result } = renderHook(() => useZonedToday("UTC"));

    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current).toBe("2026-09-01");
  });

  it("keeps the same state when visibility changes within one local day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useZonedToday("UTC");
    });
    const rendersAfterMount = renders;

    vi.setSystemTime(new Date("2026-08-31T18:00:00.000Z"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    expect(result.current).toBe("2026-08-31");
    expect(renders).toBe(rendersAfterMount);
  });
});
