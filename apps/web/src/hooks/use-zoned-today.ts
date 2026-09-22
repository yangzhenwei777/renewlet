import { useEffect, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { fromPlainDate, todayDateOnlyInTimeZone, type DateOnly } from "@/lib/time/date-only";
import { assertTimeZone } from "@/lib/time/time-zone";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function millisecondsUntilNextZonedDay(now: Date, timeZone: string): number {
  const zone = assertTimeZone(timeZone);
  const instant = Temporal.Instant.fromEpochMilliseconds(now.getTime());
  const zonedNow = instant.toZonedDateTimeISO(zone);
  const tomorrow = zonedNow.toPlainDate().add({ days: 1 });
  const nextDayStart = tomorrow.toZonedDateTime(zone);
  return Math.max(1, nextDayStart.epochMilliseconds - instant.epochMilliseconds);
}

/** 在用户本地午夜和标签页恢复可见时更新业务日期。 */
export function useZonedToday(timeZone: string): DateOnly {
  const zone = assertTimeZone(timeZone);
  const [snapshot, setSnapshot] = useState(() => ({
    timeZone: zone,
    today: todayDateOnlyInTimeZone(new Date(), zone),
  }));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    function schedule() {
      if (timer !== undefined) clearTimeout(timer);
      const now = new Date();
      const delay = Math.min(millisecondsUntilNextZonedDay(now, zone) + 50, MAX_TIMER_DELAY_MS);
      timer = setTimeout(refresh, delay);
    }
    function refresh() {
      const now = new Date();
      const today = fromPlainDate(Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(zone).toPlainDate());
      setSnapshot((current) => current.timeZone === zone && current.today === today
        ? current
        : { timeZone: zone, today });
      schedule();
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };

    refresh();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [zone]);

  return snapshot.timeZone === zone ? snapshot.today : todayDateOnlyInTimeZone(new Date(), zone);
}
