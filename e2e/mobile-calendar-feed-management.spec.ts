import { test } from "./support/test";
import { runCalendarFeedManagementJourney } from "./support/calendar-feed-management";

test("mobile manages a subscription calendar feed without horizontal overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await runCalendarFeedManagementJourney(page, testInfo, { mobile: true });
});
