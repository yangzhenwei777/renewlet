import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { expectNoHorizontalOverflow } from "./support/layout";

const mobileReleasePages: Array<{ path: string; label: string; assertReady: (page: Page) => Promise<void> }> = [
  {
    path: "/",
    label: "release mobile dashboard",
    assertReady: async (page) => {
      await expect(page.getByText("月均支出")).toBeVisible();
    },
  },
  {
    path: "/subscriptions",
    label: "release mobile subscriptions",
    assertReady: async (page) => {
      await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();
    },
  },
  {
    path: "/calendar",
    label: "release mobile calendar",
    assertReady: async (page) => {
      await expect(page.getByRole("heading", { name: "续费/到期日历", level: 1 })).toBeVisible();
    },
  },
  {
    path: "/statistics",
    label: "release mobile statistics",
    assertReady: async (page) => {
      await expect(page.getByRole("heading", { name: "统计分析", level: 1 })).toBeVisible();
    },
  },
  {
    path: "/settings",
    label: "release mobile settings",
    assertReady: async (page) => {
      await expect(page.getByRole("heading", { name: "系统配置" })).toBeVisible();
    },
  },
];

test("release smoke @release keeps primary mobile pages usable", async ({ page }) => {
  // Release smoke 只挡主导航级 H5 断裂；抽屉、日历格子和复杂表单细节留给 nightly 完整 E2E。
  for (const target of mobileReleasePages) {
    await page.goto(target.path);
    await target.assertReady(page);
    await expectNoHorizontalOverflow(page, target.label);
  }
});
