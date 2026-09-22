import { expect, type Page, type TestInfo } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./layout";
import {
  createProductSubscriptionSeed,
  deleteProductSubscriptionsByName,
} from "./product-api";
import { gotoSettingsSectionAfterHydration } from "./settings";
import { openSubscriptionCalendarDialog, uniqueE2EName } from "./subscriptions";

export async function runCalendarFeedManagementJourney(
  page: Page,
  testInfo: TestInfo,
  options: { mobile: boolean },
) {
  const subscriptionName = uniqueE2EName(
    testInfo,
    "CalendarFeedLifecycleWithAnExtraLongSubscriptionName",
  );
  await page.goto("/");
  await createProductSubscriptionSeed(page, {
    name: subscriptionName,
    price: "19.99",
    currency: "USD",
    startDate: "2099-01-01",
    nextBillingDate: "2099-06-15",
  });

  try {
    await page.goto("/subscriptions");
    await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();
    let calendarDialog = await openSubscriptionCalendarDialog(page, subscriptionName);
    await expect(calendarDialog.getByRole("heading", { name: "持续同步" })).toBeVisible();
    await expect(calendarDialog.getByRole("heading", { name: "单次添加" })).toBeVisible();
    await expect(calendarDialog.getByRole("button", { name: "下载 ICS 文件" })).toBeEnabled();
    await expect(calendarDialog.getByRole("link", { name: "用 Google Calendar 打开" })).toBeVisible();
    if (options.mobile) await expectNoHorizontalOverflow(page, "mobile add-to-calendar before feed creation");

    // 先监听响应再点击，避免本地后端立即返回后 Playwright 丢失生成或撤销请求。
    const createResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().includes("/calendar-feed")
      && !response.url().endsWith("/rotate")
    ));
    await calendarDialog.getByRole("button", { name: "生成订阅链接" }).click();
    expect((await createResponse).ok()).toBe(true);
    await expect(calendarDialog.getByLabel("本次订阅 URL")).toBeVisible();
    const revokeFromCalendar = calendarDialog.getByRole("button", { name: "撤销订阅链接" });
    const calendarDialogShell = page.locator('[role="dialog"]').filter({
      has: page.locator('[data-dialog-scroll-region="subscription-calendar"]'),
    });
    await expect(revokeFromCalendar).toBeVisible();
    await revokeFromCalendar.click();
    const calendarConfirmation = page.getByRole("alertdialog", { name: "撤销这个订阅链接？" });
    await expect(calendarConfirmation).toBeVisible();
    // Radix 会把确认框背后的父 Dialog 移出无障碍树，但视觉 shell 必须保持挂载以便取消后恢复焦点。
    await expect(calendarDialogShell).toBeVisible();
    await expect(calendarDialog).toHaveCount(0);
    await calendarConfirmation.getByRole("button", { name: "取消" }).click();
    await expect(calendarConfirmation).toBeHidden();
    await expect(calendarDialog).toBeVisible();
    await expect(revokeFromCalendar).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(calendarDialog).toBeHidden();

    await gotoSettingsSectionAfterHydration(page, "settings-calendar-feed");
    await page.locator("#settings-calendar-feed").getByRole("button", { name: "管理" }).click();
    const manager = page.getByRole("dialog", { name: "日历订阅" });
    await expect(manager).toBeVisible();
    const globalTab = manager.getByRole("tab", { name: "全部续费" });
    const subscriptionsTab = manager.getByRole("tab", { name: "单个订阅" });
    await expect(globalTab).toHaveAttribute("aria-selected", "true");
    await expect(manager.getByRole("listitem").filter({ hasText: subscriptionName })).toHaveCount(0);
    await subscriptionsTab.click();
    await expect(subscriptionsTab).toHaveAttribute("aria-selected", "true");
    const feedRow = manager.getByRole("listitem").filter({ hasText: subscriptionName });
    await expect(feedRow).toBeVisible();
    await expect(feedRow.getByRole("button", {
      name: `复制「${subscriptionName}」的日历订阅 URL`,
    })).toBeVisible();
    if (options.mobile) await expectNoHorizontalOverflow(page, "mobile calendar feed manager");

    await feedRow.getByRole("button", {
      name: `撤销「${subscriptionName}」的日历订阅链接`,
    }).click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toContainText(subscriptionName);
    const deleteResponse = page.waitForResponse((response) => (
      response.request().method() === "DELETE"
      && response.url().endsWith("/calendar-feed")
    ));
    await confirmation.getByRole("button", { name: "撤销", exact: true }).click();
    expect((await deleteResponse).ok()).toBe(true);
    await expect(confirmation).toBeHidden();
    await expect(feedRow).toHaveCount(0);
    await manager.getByRole("button", { name: "完成" }).click();
    await expect(manager).toBeHidden();

    await page.goto("/subscriptions");
    await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();
    calendarDialog = await openSubscriptionCalendarDialog(page, subscriptionName);
    await expect(calendarDialog.getByText("未启用", { exact: true })).toBeVisible();
    await expect(calendarDialog.getByRole("button", { name: "生成订阅链接" })).toBeEnabled();
    await expect(calendarDialog.getByRole("button", { name: "下载 ICS 文件" })).toBeEnabled();
    if (options.mobile) await expectNoHorizontalOverflow(page, "mobile add-to-calendar after feed revocation");
  } finally {
    await deleteProductSubscriptionsByName(page, [subscriptionName]);
  }
}
