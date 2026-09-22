// 移动端日历 E2E 关注真实 viewport 下的日历格子、详情弹层和横向溢出；这些回归通常不会被单元测试捕捉。
import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { expectNoHorizontalOverflow } from "./support/layout";
import { createProductSubscriptionSeed } from "./support/product-api";
import { uniqueE2EName } from "./support/subscriptions";

type CalendarSubscriptionSeed = {
  name: string;
  price: string;
  startDate: string;
  nextBillingDate: string;
  currency?: string;
};

async function getCurrentMonthCalendarDates(page: Page) {
  return page.evaluate(() => {
    const pad = (value: number) => value.toString().padStart(2, "0");
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const lastDay = new Date(year, month + 1, 0).getDate();
    const billingDay = Math.min(Math.max(now.getDate() + 1, 20), lastDay);
    const monthPart = pad(month + 1);

    return {
      startDate: `${year}-${monthPart}-01`,
      nextBillingDate: `${year}-${monthPart}-${pad(billingDay)}`,
    };
  });
}

async function createCalendarSubscriptionRecord(page: Page, seed: CalendarSubscriptionSeed) {
  // 直接走产品 API 种订阅，让测试聚焦日历布局，同时继续使用真实产品 session 守住用户隔离。
  await createProductSubscriptionSeed(page, seed);
}

test("calendar H5 agenda items stay inside the card container", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/");
  const dates = await getCurrentMonthCalendarDates(page);
  const longName = uniqueE2EName(testInfo, "CalendarMobileOverflowWithAVeryLongUnbrokenServiceName");

  await createCalendarSubscriptionRecord(page, {
    name: longName,
    price: "999999999.99",
    ...dates,
  });
  await createCalendarSubscriptionRecord(page, {
    name: uniqueE2EName(testInfo, "CalendarMobileNormal"),
    price: "16",
    currency: "USD",
    ...dates,
  });

  await page.goto("/calendar");
  const agenda = page.getByTestId("calendar-mobile-agenda");
  await expect(agenda).toBeVisible();
  await expect(page.getByText(longName)).toBeVisible();
  await expectNoHorizontalOverflow(page, "mobile calendar agenda");

  const metrics = await agenda.evaluate((element) => {
    const list = element.querySelector<HTMLElement>('[data-testid="calendar-mobile-agenda-list"]');
    const items = Array.from(element.querySelectorAll<HTMLElement>('[data-testid="calendar-mobile-agenda-item"]'));
    if (!list || items.length === 0) {
      throw new Error("Missing mobile calendar agenda list or items");
    }

    const agendaRect = element.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    return {
      agendaWidth: Math.round(agendaRect.width),
      listWidth: Math.round(listRect.width),
      items: items.map((item) => {
        const itemRect = item.getBoundingClientRect();
        return {
          leftInset: Math.round((itemRect.left - listRect.left) * 100) / 100,
          rightOverflow: Math.round((itemRect.right - listRect.right) * 100) / 100,
          agendaRightOverflow: Math.round((itemRect.right - agendaRect.right) * 100) / 100,
          width: Math.round(itemRect.width * 100) / 100,
        };
      }),
    };
  });

  expect(metrics.listWidth, "calendar agenda list should use the agenda width").toBeLessThanOrEqual(metrics.agendaWidth + 1);
  for (const [index, item] of metrics.items.entries()) {
    expect(item.leftInset, `calendar agenda item ${index}: left edge`).toBeGreaterThanOrEqual(-1);
    expect(item.rightOverflow, `calendar agenda item ${index}: right edge inside list`).toBeLessThanOrEqual(1);
    expect(item.agendaRightOverflow, `calendar agenda item ${index}: right edge inside agenda`).toBeLessThanOrEqual(1);
    expect(item.width, `calendar agenda item ${index}: width inside list`).toBeLessThanOrEqual(metrics.listWidth + 1);
  }
});

test("calendar H5 day drawer items stay inside the drawer container", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/");
  const dates = await getCurrentMonthCalendarDates(page);
  const billingDay = Number(dates.nextBillingDate.slice(-2));
  const longName = uniqueE2EName(testInfo, "CloudflareZeroTrustPayAsYouGoPlatformWithAnExtraLongPlanName");

  await createCalendarSubscriptionRecord(page, {
    name: longName,
    price: "999999999.99",
    currency: "USD",
    ...dates,
  });
  await createCalendarSubscriptionRecord(page, {
    name: uniqueE2EName(testInfo, "CalendarDayDrawerNormal"),
    price: "16",
    currency: "USD",
    ...dates,
  });

  await page.goto("/calendar");
  await page.getByRole("button", { name: new RegExp(`${billingDay}日 \\d+ 个事件`) }).click();

  const list = page.getByTestId("calendar-day-subscription-list");
  await expect(list).toBeVisible();
  await expect(list.getByText(longName)).toBeVisible();
  await expectNoHorizontalOverflow(page, "mobile calendar day drawer");

  const metrics = await list.evaluate((element) => {
    const items = Array.from(element.querySelectorAll<HTMLElement>('[data-testid="calendar-day-subscription-item"]'));
    if (items.length === 0) {
      throw new Error("Missing mobile calendar day drawer items");
    }

    const listRect = element.getBoundingClientRect();
    const drawerRect = element.closest<HTMLElement>("[data-vaul-drawer]")?.getBoundingClientRect();
    if (!drawerRect) {
      throw new Error("Missing mobile calendar day drawer container");
    }

    return {
      listWidth: Math.round(listRect.width),
      drawerWidth: Math.round(drawerRect.width),
      items: items.map((item) => {
        const itemRect = item.getBoundingClientRect();
        return {
          leftInset: Math.round((itemRect.left - listRect.left) * 100) / 100,
          rightOverflow: Math.round((itemRect.right - listRect.right) * 100) / 100,
          drawerRightOverflow: Math.round((itemRect.right - drawerRect.right) * 100) / 100,
          width: Math.round(itemRect.width * 100) / 100,
        };
      }),
    };
  });

  expect(metrics.listWidth, "calendar day drawer list should use the drawer width").toBeLessThanOrEqual(
    metrics.drawerWidth + 1,
  );
  for (const [index, item] of metrics.items.entries()) {
    expect(item.leftInset, `calendar day drawer item ${index}: left edge`).toBeGreaterThanOrEqual(-1);
    expect(item.rightOverflow, `calendar day drawer item ${index}: right edge inside list`).toBeLessThanOrEqual(1);
    expect(item.drawerRightOverflow, `calendar day drawer item ${index}: right edge inside drawer`).toBeLessThanOrEqual(
      1,
    );
    expect(item.width, `calendar day drawer item ${index}: width inside list`).toBeLessThanOrEqual(
      metrics.listWidth + 1,
    );
  }
});
