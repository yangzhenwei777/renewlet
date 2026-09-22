// calendar-links 测试保护 webcal/Google/Outlook URL 构造，避免公开 ICS feed token 在外部日历链接中丢失。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAndroidCalendarIntentUrl,
  CalendarFeedValidationError,
  isAndroidChromeUserAgent,
  openWebcalUrl,
  openValidatedWebcalUrl,
  toWebcalUrl,
  validateCalendarFeedUrl,
} from "./calendar-links";

const originalWindowOpen = window.open;

describe("calendar-links", () => {
  afterEach(() => {
    Object.defineProperty(window, "open", { configurable: true, value: originalWindowOpen });
  });

  it("converts HTTP calendar feed URLs to webcal URLs", () => {
    expect(toWebcalUrl("https://example.com/calendar/renewals.ics?token=secret")).toBe(
      "webcal://example.com/calendar/renewals.ics?token=secret",
    );
    expect(toWebcalUrl("http://localhost:5173/calendar/renewals.ics?token=secret")).toBe(
      "webcal://localhost:5173/calendar/renewals.ics?token=secret",
    );
  });

  it("detects Android Chrome without matching browser variants", () => {
    expect(isAndroidChromeUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36")).toBe(true);
    expect(isAndroidChromeUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit/537.36 Chrome/126.0 SamsungBrowser/27.0 Mobile Safari/537.36")).toBe(false);
    expect(isAndroidChromeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5) AppleWebKit/605.1.15 Safari/605.1.15")).toBe(false);
  });

  it("builds an Android calendar insert intent for all-day renewal events", () => {
    const href = buildAndroidCalendarIntentUrl({
      title: "Fastmail",
      description: "Team renewal; paid by card",
      startDate: "2026-06-15",
      fallbackUrl: "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Fastmail",
    });

    expect(href).toContain("intent://renewlet/calendar-event#Intent;");
    expect(href).toContain("action=android.intent.action.INSERT");
    expect(href).toContain("type=vnd.android.cursor.dir/event");
    expect(href).toContain("S.title=Fastmail");
    expect(href).toContain(`l.beginTime=${Date.UTC(2026, 5, 15)}`);
    expect(href).toContain(`l.endTime=${Date.UTC(2026, 5, 16)}`);
    expect(href).toContain("B.allDay=true");
    expect(href).toContain("S.description=Team%20renewal%3B%20paid%20by%20card");
    expect(href).toContain("S.browser_fallback_url=https%3A%2F%2Fcalendar.google.com%2Fcalendar%2Frender%3Faction%3DTEMPLATE%26text%3DFastmail");
  });

  it("opens calendar subscriptions through the webcal protocol handler", () => {
    const open = vi.fn();
    Object.defineProperty(window, "open", { configurable: true, value: open });

    const href = openWebcalUrl("https://example.com/calendar/renewals.ics?token=secret");

    expect(href).toBe("webcal://example.com/calendar/renewals.ics?token=secret");
    expect(open).toHaveBeenCalledWith("webcal://example.com/calendar/renewals.ics?token=secret", "_self");
  });

  it("validates iCalendar content before opening the system subscription handler", async () => {
    const open = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
      headers: { "content-type": "text/calendar; charset=utf-8" },
    }));
    Object.defineProperty(window, "open", { configurable: true, value: open });

    const href = await openValidatedWebcalUrl("http://localhost:3000/calendar/renewals.ics?token=secret", fetcher);

    expect(fetcher).toHaveBeenCalledWith("http://localhost:3000/calendar/renewals.ics?token=secret", {
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "text/calendar,*/*;q=0.1" },
    });
    expect(href).toBe("webcal://localhost:3000/calendar/renewals.ics?token=secret");
    expect(open).toHaveBeenCalledWith("webcal://localhost:3000/calendar/renewals.ics?token=secret", "_self");
  });

  it("rejects non-calendar responses before opening the system handler", async () => {
    const open = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(new Response("<html></html>", {
      headers: { "content-type": "text/html" },
    }));
    Object.defineProperty(window, "open", { configurable: true, value: open });

    await expect(validateCalendarFeedUrl("https://example.com/calendar/renewals.ics?token=secret", fetcher))
      .rejects.toBeInstanceOf(CalendarFeedValidationError);
    expect(open).not.toHaveBeenCalled();
  });
});
