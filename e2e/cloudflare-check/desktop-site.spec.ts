import { expect, test, type Page } from "@playwright/test";
import { gotoSettingsSectionAfterHydration } from "../support/settings";
import {
  attachNetworkSummary,
  createNetworkMonitor,
  expectNoAdminWrites,
  expectNoBlockingNetworkIssues,
  expectNoConcurrentCoreRequests,
  expectNoNotificationSideEffects,
  expectNoRepeatedSessionWithin,
  expectNoSettingsWrites,
  isApiResponse,
} from "./support/network";
import {
  cleanupTemporarySubscriptions,
  createTempPrefix,
  createTempTagName,
  createTemporarySubscription,
  deleteSubscriptionByName,
  editTemporarySubscription,
  expectSubscriptionTagsInEditDialog,
  revealCalendarEntry,
  subscriptionCard,
} from "./support/subscriptions";
import { temporaryWritesEnabled } from "./support/env";

const protectedPages: Array<{ path: string; label: string; assertReady: (page: Page) => Promise<void> }> = [
  {
    path: "/",
    label: "dashboard",
    assertReady: async (page) => {
      await expect(page.getByText("月均支出")).toBeVisible();
    },
  },
  {
    path: "/subscriptions",
    label: "subscriptions",
    assertReady: async (page) => {
      await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();
      await expectExistingPrivateLogoLoads(page);
    },
  },
  {
    path: "/calendar",
    label: "calendar",
    assertReady: async (page) => {
      await expect(page.getByRole("heading", { name: "续费/到期日历", level: 1 })).toBeVisible();
    },
  },
  {
    path: "/statistics",
    label: "statistics",
    assertReady: async (page) => {
      await expect(page.getByRole("heading", { name: "统计分析", level: 1 })).toBeVisible();
    },
  },
  {
    path: "/settings",
    label: "settings",
    assertReady: async (page) => {
      await expect(page.getByRole("heading", { name: "系统配置" })).toBeVisible();
    },
  },
  {
    path: "/admin/users",
    label: "admin users",
    assertReady: async (page) => {
      await expect(page.getByRole("heading", { name: "用户管理" })).toBeVisible();
      await expect(page.getByText("不能禁用、降级或删除当前登录账号")).toBeVisible();
    },
  },
];

test("protected desktop pages render without API or session bursts", async ({ page }, testInfo) => {
  const monitor = createNetworkMonitor(page);
  try {
    // 这组巡检只读访问所有核心页；任何写 API 都应被 network monitor 当成线上副作用拦下。
    for (const target of protectedPages) {
      await page.goto(target.path);
      await target.assertReady(page);
    }

    expectNoBlockingNetworkIssues(monitor, "protected desktop pages");
    expectNoAdminWrites(monitor, "protected desktop pages");
    expectNoConcurrentCoreRequests(monitor, "protected desktop pages");
    expectNoRepeatedSessionWithin(monitor, "protected desktop pages");
  } finally {
    await attachNetworkSummary(testInfo, monitor);
  }
});

test("settings notification history filter does not disturb next-check summary", async ({ page }, testInfo) => {
  const monitor = createNetworkMonitor(page);
  try {
    const initialHistoryRead = page.waitForResponse((response) =>
      isApiResponse(response, "/api/app/notifications/history", "GET"),
    );
    await gotoSettingsSectionAfterHydration(page, "settings-notifications");
    await initialHistoryRead;

    const summaryBefore = await readNotificationSummaryText(page);
    await page.getByRole("button", { name: "查看调度与历史" }).click();
    await page.getByRole("tab", { name: "发送历史" }).click();
    const skippedHistoryRead = page.waitForResponse((response) =>
      isApiResponse(response, "/api/app/notifications/history", "GET") &&
      new URL(response.url()).searchParams.get("status") === "skipped",
    );
    await page.getByRole("button", { name: "已跳过" }).first().click();
    await skippedHistoryRead;
    await expect(page.getByRole("dialog", { name: "通知调度与发送历史" })).toBeVisible();

    const summaryAfter = await readNotificationSummaryText(page);
    expect(summaryAfter, "history filter must not mutate outer next-check summary").toBe(summaryBefore);

    expectNoNotificationSideEffects(monitor, "settings notification history filter");
    expectNoSettingsWrites(monitor, "settings notification history filter");
    expectNoBlockingNetworkIssues(monitor, "settings notification history filter");
    expectNoConcurrentCoreRequests(monitor, "settings notification history filter");
    expectNoRepeatedSessionWithin(monitor, "settings notification history filter");
  } finally {
    await attachNetworkSummary(testInfo, monitor);
  }
});

test("temporary subscription write-edit-read-delete is consistent across pages", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  test.skip(!temporaryWritesEnabled(), "RENEWLET_E2E_WRITE_SCOPE=readonly 时跳过临时写删巡检。");

  const monitor = createNetworkMonitor(page);
  const prefix = createTempPrefix(testInfo);
  const initialName = `${prefix}-subscription`;
  const editedName = `${prefix}-subscription-edited`;
  const tagName = createTempTagName(testInfo);

  try {
    // 写删巡检使用 e2e-prod 前缀并在 finally 清理；只读生产烟测必须通过 write scope 跳过这里。
    await page.goto("/subscriptions");
    await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();
    await cleanupTemporarySubscriptions(page, "e2e-prod-");
    await createTemporarySubscription(page, {
      name: initialName,
      price: "98765.43",
      tags: tagName,
    });

    await editTemporarySubscription(page, initialName, {
      name: editedName,
      price: "123456.78",
      tags: `${tagName}、线上巡检`,
    });
    await expect(subscriptionCard(page, editedName)).toBeVisible();

    await page.goto("/");
    await expect(page.getByText("月均支出")).toBeVisible();
    await expect(subscriptionCard(page, editedName)).toBeVisible();

    await page.goto("/calendar");
    await expect(page.getByRole("heading", { name: "续费/到期日历", level: 1 })).toBeVisible();
    await revealCalendarEntry(page, editedName);

    await page.goto("/statistics");
    await expect(page.getByRole("heading", { name: "统计分析", level: 1 })).toBeVisible();
    await expect(page.getByText(editedName).first()).toBeVisible();

    await page.goto("/subscriptions");
    await expect(subscriptionCard(page, editedName)).toBeVisible();
    await expectSubscriptionTagsInEditDialog(page, editedName, [tagName, "线上巡检"]);
    await deleteSubscriptionByName(page, editedName);
    await expect(subscriptionCard(page, editedName)).toBeHidden();

    await page.goto("/calendar");
    await expect(page.getByRole("button", { name: editedName, exact: true })).toHaveCount(0);
    await page.goto("/statistics");
    await expect(page.getByText(editedName)).toHaveCount(0);

    expectNoBlockingNetworkIssues(monitor, "temporary subscription lifecycle");
    expectNoConcurrentCoreRequests(monitor, "temporary subscription lifecycle");
    expectNoRepeatedSessionWithin(monitor, "temporary subscription lifecycle");
  } finally {
    await cleanupTemporarySubscriptions(page, prefix);
    await attachNetworkSummary(testInfo, monitor);
  }
});

async function readNotificationSummaryText(page: Page): Promise<string> {
  const summary = page.locator(".rounded-lg")
    .filter({ hasText: "下一次检查" })
    .filter({ hasText: "下一次有内容" })
    .filter({ hasText: "最近执行" })
    .first();
  await expect(summary).toBeVisible();
  return (await summary.textContent() ?? "").replace(/\s+/g, " ").trim();
}

async function expectExistingPrivateLogoLoads(page: Page) {
  const logo = page.locator("img.subscription-logo-image").first();
  if (!(await logo.isVisible().catch(() => false))) return;
  // 私有 Logo 经过 Worker/R2 代理和浏览器解码；轮询 naturalWidth 比等待 networkidle 更贴近真实渲染完成。
  await expect.poll(async () => logo.evaluate((element) => (
    element instanceof HTMLImageElement ? element.complete && element.naturalWidth > 0 : false
  )), { message: "existing private subscription logo should load" }).toBe(true);
}
