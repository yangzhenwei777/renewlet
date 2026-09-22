/**
 * 用户本地时间调度工具。
 *
 * Cron 可以按 UTC 高频触发，但是否真正发送通知必须按用户的：
 * 本地日期 + 本地墙钟时间 + IANA 时区判断。
 */
import { Temporal } from "@js-temporal/polyfill";
import { assertDateOnly, fromPlainDate, type DateOnly } from "@/lib/time/date-only";
import { assertLocalTime, type LocalTime } from "@/lib/time/local-time";
import { assertTimeZone } from "@/lib/time/time-zone";

/** 用户本地调度判断结果；Cron 依赖其中的本地日期/时间构造幂等键。 */
export interface LocalScheduleDecision {
  due: boolean;
  scheduledLocalDate: DateOnly;
  scheduledLocalTime: LocalTime;
  timeZone: string;
  scheduledInstantUtc: string;
  reason?: string;
}

export interface LocalScheduleOccurrence {
  scheduledLocalDate: DateOnly;
  scheduledLocalTime: LocalTime;
  timeZone: string;
  scheduledInstantUtc: string;
}

function instantFromDate(date: Date): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime());
}

function localDateTimeToInstant(
  localDate: DateOnly | string,
  localTime: LocalTime | string,
  timeZone: string,
): Temporal.Instant {
  const date = assertDateOnly(localDate);
  const time = assertLocalTime(localTime);
  return Temporal.PlainDateTime.from(`${date}T${time}`)
    .toZonedDateTime(timeZone, { disambiguation: "compatible" })
    .toInstant();
}

export function getLocalScheduleInstantUtc(data: {
  scheduledLocalDate: DateOnly | string;
  scheduledLocalTime: LocalTime | string;
  timeZone: string;
}): string {
  const timeZone = assertTimeZone(data.timeZone);
  return localDateTimeToInstant(data.scheduledLocalDate, data.scheduledLocalTime, timeZone).toString();
}

function buildDecision(
  nowInstant: Temporal.Instant,
  localDate: DateOnly,
  localTime: LocalTime,
  timeZone: string,
  windowMinutes: number,
): LocalScheduleDecision {
  const scheduledInstant = localDateTimeToInstant(localDate, localTime, timeZone);
  const deltaMinutes = (nowInstant.epochMilliseconds - scheduledInstant.epochMilliseconds) / 60_000;
  return {
    due: deltaMinutes >= 0 && deltaMinutes <= windowMinutes,
    scheduledLocalDate: localDate,
    scheduledLocalTime: localTime,
    timeZone,
    scheduledInstantUtc: scheduledInstant.toString(),
    reason: deltaMinutes < 0 ? "before_scheduled_time" : `not_in_time_window(delta=${Math.floor(deltaMinutes)}m)`,
  };
}

/**
 * 判断当前 UTC 时刻是否命中用户本地计划时间窗口。
 *
 * 边界控制：同时检查今天和昨天，可覆盖跨午夜延迟触发的 Cron。
 */
export function getLocalScheduleDecision(data: {
  now: Date;
  timeZone: string;
  scheduledLocalTime: string;
  windowMinutes: number;
  force?: boolean;
}): LocalScheduleDecision {
  const timeZone = assertTimeZone(data.timeZone);
  const scheduledLocalTime = assertLocalTime(data.scheduledLocalTime);
  const windowMinutes = Math.max(0, Math.floor(data.windowMinutes));
  const nowInstant = instantFromDate(data.now);
  const nowZoned = nowInstant.toZonedDateTimeISO(timeZone);
  const today = fromPlainDate(nowZoned.toPlainDate());

  if (data.force) {
    const scheduledInstant = localDateTimeToInstant(today, scheduledLocalTime, timeZone);
    return {
      due: true,
      scheduledLocalDate: today,
      scheduledLocalTime,
      timeZone,
      scheduledInstantUtc: scheduledInstant.toString(),
      reason: "force",
    };
  }

  const todayDecision = buildDecision(nowInstant, today, scheduledLocalTime, timeZone, windowMinutes);
  if (todayDecision.due || todayDecision.reason === "not_in_time_window(delta=0m)") return todayDecision;

  // 跨午夜延迟：例如本地 00:01 才触发 Cron，应仍可补发前一天 23:59 的任务。
  const yesterday = fromPlainDate(nowZoned.toPlainDate().subtract({ days: 1 }));
  const yesterdayDecision = buildDecision(nowInstant, yesterday, scheduledLocalTime, timeZone, windowMinutes);
  if (yesterdayDecision.due) return yesterdayDecision;

  return todayDecision;
}

/** 返回当前时刻之后的下一次用户本地通知时间。 */
export function getNextLocalScheduleOccurrence(data: {
  now: Date;
  timeZone: string;
  scheduledLocalTime: string;
}): LocalScheduleOccurrence {
  const timeZone = assertTimeZone(data.timeZone);
  const scheduledLocalTime = assertLocalTime(data.scheduledLocalTime);
  const nowInstant = instantFromDate(data.now);
  const nowZoned = nowInstant.toZonedDateTimeISO(timeZone);
  const today = fromPlainDate(nowZoned.toPlainDate());
  const todayInstant = localDateTimeToInstant(today, scheduledLocalTime, timeZone);
  const scheduledLocalDate =
    todayInstant.epochMilliseconds >= nowInstant.epochMilliseconds
      ? today
      : fromPlainDate(nowZoned.toPlainDate().add({ days: 1 }));
  const scheduledInstant = localDateTimeToInstant(scheduledLocalDate, scheduledLocalTime, timeZone);

  return {
    scheduledLocalDate,
    scheduledLocalTime,
    timeZone,
    scheduledInstantUtc: scheduledInstant.toString(),
  };
}
