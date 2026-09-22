// runtime 测试保护 reminderDays 哨兵值；Go、D1、前端和导入导出都依赖这组三态语义。
import { describe, expect, it } from "vitest";
import {
  DISABLED_REMINDER_DAYS,
  INHERIT_REMINDER_DAYS,
  effectiveReminderDays,
  isValidReminderDays,
} from "./runtime";

describe("reminder day runtime contract", () => {
  it("accepts disabled, inherited and explicit reminder boundaries", () => {
    for (const value of [DISABLED_REMINDER_DAYS, INHERIT_REMINDER_DAYS, 0, 3650]) {
      expect(isValidReminderDays(value)).toBe(true);
    }

    for (const value of [-3, 3651]) {
      expect(isValidReminderDays(value)).toBe(false);
    }
  });

  it("does not resolve disabled reminders into an effective day count", () => {
    expect(effectiveReminderDays(DISABLED_REMINDER_DAYS, 3)).toBeUndefined();
    expect(effectiveReminderDays(INHERIT_REMINDER_DAYS, 5)).toBe(5);
    expect(effectiveReminderDays(0, 5)).toBe(0);
  });
});
