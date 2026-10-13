import { Temporal } from "@js-temporal/polyfill";

export function scheduleInstantUtc(localDate: string, localTime: string, timeZone: string): string {
  // compatible 是两端共同约定：缺失墙钟时间按跳变量顺延，重复时间取首次；不能按整小时试探偏移。
  return Temporal.PlainDate.from(localDate).toPlainDateTime(localTime)
    .toZonedDateTime(timeZone, { disambiguation: "compatible" })
    .toInstant().toString({ smallestUnit: "second" });
}
