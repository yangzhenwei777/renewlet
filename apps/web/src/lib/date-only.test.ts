// DateOnly 测试保护纯日期算法，避免 JS Date 时区换算把续费日推前或推后一天。
import { describe, expect, it } from "vitest";
import { assertDateOnly, dateOnlyToLocalDate, isValidDateOnly } from "@/lib/time/date-only";

describe("date-only", () => {
  it("accepts only real YYYY-MM-DD dates", () => {
    expect(isValidDateOnly("2026-02-28")).toBe(true);
    expect(isValidDateOnly("2026-02-31")).toBe(false);
    expect(isValidDateOnly("2026-13-01")).toBe(false);
    expect(isValidDateOnly("")).toBe(false);
  });

  it("rejects ISO datetimes instead of normalizing across time zones", () => {
    expect(() => assertDateOnly("2026-01-10T23:30:00.000Z")).toThrow("Invalid date-only");
    expect(() => assertDateOnly("2026-02-31")).toThrow("Invalid date-only");
  });

  it("throws before parsing invalid date-only values into Date", () => {
    expect(assertDateOnly("2026-12-01")).toBe("2026-12-01");
    expect(dateOnlyToLocalDate(assertDateOnly("2026-12-01")).getFullYear()).toBe(2026);
    expect(() => dateOnlyToLocalDate("2026-02-31")).toThrow("Invalid date-only");
  });
});
