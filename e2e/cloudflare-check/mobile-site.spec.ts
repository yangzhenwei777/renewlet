import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "../support/layout";
import { gotoSettingsSectionAfterHydration } from "../support/settings";
import {
  attachNetworkSummary,
  createNetworkMonitor,
  expectNoBlockingNetworkIssues,
  expectNoConcurrentCoreRequests,
  expectNoRepeatedSessionWithin,
  expectNoSettingsWrites,
} from "./support/network";
import { openAddSubscriptionDialog } from "./support/subscriptions";

const mobilePages: Array<{ path: string; label: string; assertReady: (page: Page) => Promise<void> }> = [
  {
    path: "/",
    label: "mobile dashboard",
    assertReady: async (page) => {
      await expect(page.getByText("月均支出")).toBeVisible();
    },
  },
  {
    path: "/subscriptions",
    label: "mobile subscriptions",
    assertReady: async (page) => {
      await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();
    },
  },
  {
    path: "/calendar",
    label: "mobile calendar",
    assertReady: async (page) => {
      await expect(page.getByRole("heading", { name: "续费/到期日历", level: 1 })).toBeVisible();
    },
  },
  {
    path: "/statistics",
    label: "mobile statistics",
    assertReady: async (page) => {
      await expect(page.getByRole("heading", { name: "统计分析", level: 1 })).toBeVisible();
    },
  },
  {
    path: "/settings",
    label: "mobile settings",
    assertReady: async (page) => {
      await expect(page.getByRole("heading", { name: "系统配置" })).toBeVisible();
    },
  },
];

test("mobile core pages have no horizontal overflow", async ({ page }, testInfo) => {
  const monitor = createNetworkMonitor(page);
  try {
    // 移动巡检的主信号是布局约束；页面 ready 后立刻测 overflow，避免滚动后状态掩盖首屏问题。
    for (const target of mobilePages) {
      await page.goto(target.path);
      await target.assertReady(page);
      await expectNoHorizontalOverflow(page, target.label);
    }

    expectNoBlockingNetworkIssues(monitor, "mobile core pages");
    expectNoConcurrentCoreRequests(monitor, "mobile core pages");
    expectNoRepeatedSessionWithin(monitor, "mobile core pages");
  } finally {
    await attachNetworkSummary(testInfo, monitor);
  }
});

test("mobile sheets, dialogs, and notification history stay usable", async ({ page }, testInfo) => {
  const monitor = createNetworkMonitor(page);
  try {
    await page.goto("/subscriptions");
    await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();
    const subscriptionDialog = await openAddSubscriptionDialog(page);
    await expectMobileActionVisibleAfterKeyboardViewportChange(page, subscriptionDialog);
    await expectNoHorizontalOverflow(page, "mobile subscription dialog");
    await subscriptionDialog.getByRole("button", { name: "取消" }).click();
    await expect(subscriptionDialog).toBeHidden();

    await gotoSettingsSectionAfterHydration(page, "settings-data-config");
    await page.getByRole("button", { name: /货币管理/ }).click();
    const currencyDialog = page.getByRole("dialog", { name: "货币管理" });
    await expect(currencyDialog).toBeVisible();
    await expectNoHorizontalOverflow(page, "mobile currency manager");
    await currencyDialog
      .locator("[data-settings-manager-footer]")
      .getByRole("button", { name: /^(关闭|Close)$/ })
      .click();
    await expect(currencyDialog).toBeHidden();

    await page.getByRole("button", { name: "查看调度与历史" }).click();
    const historyDialog = page.getByRole("dialog", { name: "通知调度与发送历史" });
    await expect(historyDialog).toBeVisible();
    await page.getByRole("tab", { name: "发送历史" }).click();
    await expectNoHorizontalOverflow(page, "mobile notification history dialog");

    const historyRows = page.getByTestId("notification-history-row");
    if (await historyRows.first().isVisible().catch(() => false)) {
      await historyRows.first().click();
      const drawer = page.getByTestId("notification-history-detail-drawer");
      await expect(drawer).toBeVisible();
      await expectNoHorizontalOverflow(page, "mobile notification history drawer");
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
    }

    await historyDialog
      .locator("[data-settings-manager-footer]")
      .getByRole("button", { name: /^(关闭|Close)$/ })
      .click();
    await expect(historyDialog).toBeHidden();

    expectNoBlockingNetworkIssues(monitor, "mobile overlays");
    expectNoConcurrentCoreRequests(monitor, "mobile overlays");
    expectNoRepeatedSessionWithin(monitor, "mobile overlays");
    expectNoSettingsWrites(monitor, "mobile overlays");
  } finally {
    await attachNetworkSummary(testInfo, monitor);
  }
});

async function expectMobileActionVisibleAfterKeyboardViewportChange(page: Page, dialog: Locator) {
  await dialog.getByLabel("服务名称", { exact: true }).focus();
  await page.evaluate(() => {
    // visual viewport 变量模拟软键盘顶起后的空间压缩，覆盖真实移动浏览器最容易丢底部按钮的场景。
    document.documentElement.style.setProperty("--app-layout-viewport-height", "640px");
    document.documentElement.style.setProperty("--app-visual-viewport-offset-top", "180px");
    document.documentElement.style.setProperty("--app-visual-viewport-offset-left", "0px");
    document.documentElement.style.setProperty("--app-viewport-height", "360px");
  });
  await expect(dialog.getByRole("button", { name: "添加订阅" })).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--app-visual-viewport-offset-top", "0px");
    document.documentElement.style.setProperty("--app-viewport-height", "640px");
  });
}
