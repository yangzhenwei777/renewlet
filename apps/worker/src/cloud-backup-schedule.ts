import {
  type CloudBackupPolicy,
  type CloudBackupScheduleWeekday,
} from "@renewlet/shared/schemas/cloud-backup";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import { addDays, dateOnlyInZone, localTimeInZone, safeTimeZone } from "./time";

type CloudBackupScheduleTarget = {
  policy: CloudBackupPolicy;
  lastBackupAt: string | null;
};

export function cloudBackupTargetDue(target: CloudBackupScheduleTarget, timezone: string, now: Date): boolean {
  if (!target.policy.scheduleEnabled) return false;
  const scheduledAt = latestCloudBackupScheduledInstant(now, timezone, target.policy);
  if (!scheduledAt || scheduledAt.getTime() > now.getTime()) return false;
  // 到期判断用“最近一次应执行时间”补跑停机窗口；lastBackupAt 只按当前 provider 自己的状态比较。
  if (!target.lastBackupAt) return true;
  const last = new Date(target.lastBackupAt);
  if (Number.isNaN(last.getTime())) return true;
  return last.getTime() < scheduledAt.getTime();
}

export function cloudBackupNextRunAt(target: CloudBackupScheduleTarget, timezone: string, now: Date): string | null {
  if (!target.policy.scheduleEnabled) return null;
  const scheduledAt = latestCloudBackupScheduledInstant(now, timezone, target.policy);
  // 返回“仍欠账的最近计划点”而不是强行算未来时间；失败重试必须复用同一个 due instant。
  if (scheduledAt && scheduledAt.getTime() <= now.getTime()) {
    if (!target.lastBackupAt) return scheduledAt.toISOString();
    const last = new Date(target.lastBackupAt);
    if (Number.isNaN(last.getTime()) || last.getTime() < scheduledAt.getTime()) return scheduledAt.toISOString();
  }
  return nextCloudBackupScheduledInstant(now, timezone, target.policy)?.toISOString() ?? null;
}

export function createDefaultFallbackSettings(): ApiAppSettings {
  return createDefaultAppSettings();
}

function latestCloudBackupScheduledInstant(now: Date, timezone: string, policy: CloudBackupPolicy): Date | null {
  const safeTimezone = safeTimeZone(timezone);
  // 云备份定时使用用户 IANA timezone；非法设置回退 UTC，避免 scheduled 任务永久跳过。
  const localDate = dateOnlyInZone(now, safeTimezone);
  let scheduledDate = localDate;
  if (policy.scheduleFrequency === "weekly") {
    scheduledDate = addDays(localDate, -weekdayDistanceBack(weekdayNameInZone(now, safeTimezone), policy.scheduleWeekday));
  }
  let scheduled = new Date(zonedWallTimeToUtc(scheduledDate, policy.scheduleTime, safeTimezone));
  if (scheduled.getTime() > now.getTime()) {
    scheduledDate = addDays(scheduledDate, policy.scheduleFrequency === "weekly" ? -7 : -1);
    scheduled = new Date(zonedWallTimeToUtc(scheduledDate, policy.scheduleTime, safeTimezone));
  }
  return Number.isNaN(scheduled.getTime()) ? null : scheduled;
}

function nextCloudBackupScheduledInstant(now: Date, timezone: string, policy: CloudBackupPolicy): Date | null {
  const safeTimezone = safeTimeZone(timezone);
  const localDate = dateOnlyInZone(now, safeTimezone);
  if (policy.scheduleFrequency === "weekly") {
    for (let offset = 0; offset <= 7; offset += 1) {
      const scheduledDate = addDays(localDate, offset);
      if (weekdayNameForDateOnly(scheduledDate) !== policy.scheduleWeekday) continue;
      const scheduled = new Date(zonedWallTimeToUtc(scheduledDate, policy.scheduleTime, safeTimezone));
      if (!Number.isNaN(scheduled.getTime()) && scheduled.getTime() > now.getTime()) return scheduled;
    }
    return null;
  }
  const todayScheduled = new Date(zonedWallTimeToUtc(localDate, policy.scheduleTime, safeTimezone));
  if (!Number.isNaN(todayScheduled.getTime()) && todayScheduled.getTime() > now.getTime()) return todayScheduled;
  const tomorrow = new Date(zonedWallTimeToUtc(addDays(localDate, 1), policy.scheduleTime, safeTimezone));
  return Number.isNaN(tomorrow.getTime()) ? null : tomorrow;
}

function weekdayNameInZone(date: Date, timezone: string): CloudBackupScheduleWeekday {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(date).toLowerCase();
  return cloudBackupWeekdayFromName(name);
}

function weekdayNameForDateOnly(date: string): CloudBackupScheduleWeekday {
  return cloudBackupWeekdayFromName(new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(`${date}T12:00:00.000Z`)).toLowerCase());
}

function cloudBackupWeekdayFromName(name: string): CloudBackupScheduleWeekday {
  if (name === "sunday") return "sunday";
  if (name === "tuesday") return "tuesday";
  if (name === "wednesday") return "wednesday";
  if (name === "thursday") return "thursday";
  if (name === "friday") return "friday";
  if (name === "saturday") return "saturday";
  return "monday";
}

function weekdayDistanceBack(current: CloudBackupScheduleWeekday, target: CloudBackupScheduleWeekday): number {
  const order: CloudBackupScheduleWeekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return (order.indexOf(current) - order.indexOf(target) + 7) % 7;
}

function zonedWallTimeToUtc(date: string, time: string, timezone: string): string {
  const [hour = "0", minute = "0"] = time.split(":");
  const guess = new Date(`${date}T${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:00.000Z`);
  for (let offset = -26; offset <= 26; offset += 1) {
    const utc = new Date(guess.getTime() + offset * 60 * 60 * 1000).toISOString();
    const shownDate = dateOnlyInZone(new Date(utc), timezone);
    const shownTime = localTimeInZone(new Date(utc), timezone);
    if (shownDate === date && shownTime === time) return utc;
  }
  return guess.toISOString();
}
