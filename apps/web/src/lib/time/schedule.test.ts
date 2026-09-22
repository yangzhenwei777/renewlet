// schedule 测试保护 IANA timezone 与本地 HH:mm 到 UTC instant 的转换，通知 cron 预览依赖同一口径。
import { describe, expect, it } from "vitest";
import { getLocalScheduleDecision } from "./schedule";

describe("local notification schedule", () => {
  it("triggers at the user's local time regardless of UTC offset", () => {
    const decision = getLocalScheduleDecision({
      now: new Date("2026-01-01T13:00:00.000Z"),
      timeZone: "America/New_York",
      scheduledLocalTime: "08:00",
      windowMinutes: 2,
    });

    expect(decision).toMatchObject({
      due: true,
      scheduledLocalDate: "2026-01-01",
      scheduledLocalTime: "08:00",
      timeZone: "America/New_York",
    });
  });

  it("handles UTC+14 users on their own local date", () => {
    const decision = getLocalScheduleDecision({
      now: new Date("2026-01-01T18:00:00.000Z"),
      timeZone: "Pacific/Kiritimati",
      scheduledLocalTime: "08:00",
      windowMinutes: 2,
    });

    expect(decision.due).toBe(true);
    expect(decision.scheduledLocalDate).toBe("2026-01-02");
  });

  it("moves nonexistent spring-forward local time to the next valid instant", () => {
    const decision = getLocalScheduleDecision({
      now: new Date("2026-03-08T07:30:00.000Z"),
      timeZone: "America/New_York",
      scheduledLocalTime: "02:30",
      windowMinutes: 2,
    });

    expect(decision.due).toBe(true);
    expect(decision.scheduledLocalDate).toBe("2026-03-08");
    expect(decision.scheduledInstantUtc).toBe("2026-03-08T07:30:00Z");
  });

  it("uses the same local idempotency key during the repeated fall-back hour", () => {
    const first = getLocalScheduleDecision({
      now: new Date("2026-11-01T05:30:00.000Z"),
      timeZone: "America/New_York",
      scheduledLocalTime: "01:30",
      windowMinutes: 120,
    });
    const second = getLocalScheduleDecision({
      now: new Date("2026-11-01T06:30:00.000Z"),
      timeZone: "America/New_York",
      scheduledLocalTime: "01:30",
      windowMinutes: 120,
    });

    expect(first.due).toBe(true);
    expect(second.due).toBe(true);
    expect(first.scheduledLocalDate).toBe(second.scheduledLocalDate);
    expect(first.scheduledLocalTime).toBe(second.scheduledLocalTime);
    expect(first.timeZone).toBe(second.timeZone);
  });

  it("can catch a previous local day schedule shortly after midnight", () => {
    const decision = getLocalScheduleDecision({
      now: new Date("2026-01-02T05:01:00.000Z"),
      timeZone: "America/New_York",
      scheduledLocalTime: "23:59",
      windowMinutes: 3,
    });

    expect(decision.due).toBe(true);
    expect(decision.scheduledLocalDate).toBe("2026-01-01");
  });
});
