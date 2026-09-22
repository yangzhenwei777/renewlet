/**
 * ICS 生成器是服务端/Worker 的日历序列化层。
 *
 * 它只接收应用已经计算好的下一次 date-only 事件；前端浏览器不得直接引用本模块，
 * 避免 `ical-generator` 的安全上下文假设重新进入 UI 渲染链路。
 */
import ical, { ICalAlarmType, ICalCalendarMethod } from "ical-generator";
import type { RenewalCalendarEvent } from "./calendar-events";

export interface RenewalCalendarOptions {
  name: string;
  sourceUrl?: string;
  generatedAt: Date;
  events: RenewalCalendarEvent[];
}

const CALENDAR_TTL_SECONDS = 60 * 60;
const PROD_ID = {
  company: "Renewlet",
  language: "EN",
  product: "Renewal Calendar",
} as const;

/**
 * 生成公开日历订阅内容。
 *
 * Renewlet 只导出当前 nextBillingDate 的全日事件，不写 RRULE；
 * 续费算法仍由应用自己计算，外部日历只负责订阅展示。
 */
export function buildRenewalCalendarIcs(options: RenewalCalendarOptions): string {
  const calendar = ical({
    method: ICalCalendarMethod.PUBLISH,
    name: options.name,
    prodId: PROD_ID,
    scale: "GREGORIAN",
  });
  if (options.sourceUrl) {
    calendar.source(options.sourceUrl);
    calendar.ttl(CALENDAR_TTL_SECONDS);
  }

  const events = [...options.events].sort((left, right) => {
    const dateOrder = left.date.localeCompare(right.date);
    return dateOrder === 0 ? left.summary.localeCompare(right.summary) : dateOrder;
  });

  for (const event of events) {
    // date-only 续费事件只承载 Renewlet 已计算出的下一次日期；不写 RRULE，避免外部日历自行推算后漂移。
    const calendarEvent = calendar.createEvent({
      allDay: true,
      description: event.description,
      end: dateOnlyToUtcDate(addDateOnly(event.date, 1)),
      id: event.uid,
      stamp: options.generatedAt,
      start: dateOnlyToUtcDate(event.date),
      summary: event.summary,
    });
    calendarEvent.uid(event.uid);
    if (event.categories) {
      calendarEvent.createCategory({ name: event.categories });
    }
    if (event.url) {
      calendarEvent.url(event.url);
    }
    if (typeof event.reminderDays === "number" && event.reminderDays >= 0) {
      calendarEvent.createAlarm({
        description: event.summary,
        trigger: Math.max(0, event.reminderDays) * 86_400,
        type: ICalAlarmType.display,
      });
    }
  }

  return calendar.toString();
}

function addDateOnly(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return new Date(timestamp + days * 86_400_000).toISOString().slice(0, 10);
}

function dateOnlyToUtcDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}
