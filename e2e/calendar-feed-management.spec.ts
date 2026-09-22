import { test } from "./support/test";
import { runCalendarFeedManagementJourney } from "./support/calendar-feed-management";

test("desktop manages a subscription calendar feed across subscription and settings dialogs", async ({ page }, testInfo) => {
  await runCalendarFeedManagementJourney(page, testInfo, { mobile: false });
});
