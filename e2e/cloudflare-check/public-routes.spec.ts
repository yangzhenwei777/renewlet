import { expect, test, type Page } from "@playwright/test";
import { expectLoginForm, loginThroughCloudflareUI, logoutThroughCloudflareUI } from "./support/auth";
import { getCloudflareCheckEnv } from "./support/env";
import {
  attachNetworkSummary,
  createNetworkMonitor,
  expectNoBlockingNetworkIssues,
  expectNoConcurrentCoreRequests,
  expectNoRepeatedSessionWithin,
} from "./support/network";

const publicRoutes: Array<{ path: string; assert: (page: Page) => Promise<void> }> = [
  {
    path: "/login",
    assert: async (page) => {
      await expectLoginForm(page);
    },
  },
  {
    path: "/setup",
    assert: async (page) => {
      await expect(page.getByRole("heading", { name: /初始化 Renewlet|初始化已完成/ })).toBeVisible();
    },
  },
  {
    path: "/forgot-password",
    assert: async (page) => {
      await expect(page.getByRole("heading", { name: "找回密码" })).toBeVisible();
      await expect(page.getByText(/当前部署未启用邮件找回密码|输入登录邮箱/)).toBeVisible();
    },
  },
  {
    path: "/reset-password",
    assert: async (page) => {
      await expect(page.getByRole("heading", { name: "设置新密码" })).toBeVisible();
      await expect(page.getByText("重置链接缺少 token，无法设置新密码。")).toBeVisible();
    },
  },
  {
    path: "/privacy",
    assert: async (page) => {
      await expect(page.getByRole("heading", { name: "隐私政策" })).toBeVisible();
    },
  },
  {
    path: "/terms",
    assert: async (page) => {
      await expect(page.getByRole("heading", { name: "服务条款" })).toBeVisible();
    },
  },
];

test("public routes and SPA fallback stay reachable without login", async ({ page }, testInfo) => {
  const monitor = createNetworkMonitor(page);
  try {
    // 公开路由巡检不依赖测试账号，fork/只读生产环境也能覆盖 Worker routing 与 Static Assets fallback。
    // health 走浏览器页面通道，避免 Playwright request fixture 与真实 Chromium 在代理/IPv6 路径上出现不同网络结果。
    const healthResponse = await page.goto("/api/app/health");
    const healthBody = await page.locator("body").textContent();
    expect(healthResponse?.ok(), healthBody ?? "empty health response").toBe(true);
    await expect(page.locator("body")).toContainText('"ok":true');

    for (const route of publicRoutes) {
      await page.goto(route.path);
      await expect.poll(() => new URL(page.url()).pathname, { message: `${route.path} should not redirect` })
        .toBe(route.path);
      await route.assert(page);
    }

    await page.goto("/index.html");
    await expect.poll(() => new URL(page.url()).pathname, { message: "/index.html should load the SPA entry" })
      .toBe("/login");
    await expectLoginForm(page);

    await page.goto("/__renewlet-cloudflare-check-missing-route");
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
    await expect(page.getByText("页面未找到")).toBeVisible();

    expectNoBlockingNetworkIssues(monitor, "public route sweep", {
      allowConsoleError: [/404 Error: User attempted to access non-existent route/],
    });
    expectNoConcurrentCoreRequests(monitor, "public route sweep");
  } finally {
    await attachNetworkSummary(testInfo, monitor);
  }
});

test("auth guard returns to requested protected page and logout clears private API state", async ({ page }, testInfo) => {
  test.skip(!getCloudflareCheckEnv().credentials, "未设置线上巡检账号，只执行公开路由检查。");

  const monitor = createNetworkMonitor(page);
  try {
    // next 参数是登录守卫的核心契约；线上巡检要覆盖真实 Worker session 写入后的回跳。
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login\?next=/);
    expect(new URL(page.url()).searchParams.get("next")).toBe("/settings");

    await loginThroughCloudflareUI(page, "/settings");
    await expect(page.getByRole("heading", { name: "系统配置" })).toBeVisible();

    await page.goto("/");
    await expect(page.getByText("月均支出")).toBeVisible();
    await logoutThroughCloudflareUI(page);
    const privateApiStatus = await page.evaluate(async () => {
      const response = await fetch("/api/app/subscriptions");
      return response.status;
    });
    expect(privateApiStatus, "private API should reject after logout").toBe(401);

    expectNoBlockingNetworkIssues(monitor, "auth guard and logout", {
      allowApiError: (record) => record.pathname === "/api/app/subscriptions" && record.status === 401,
    });
    expectNoConcurrentCoreRequests(monitor, "auth guard and logout");
    expectNoRepeatedSessionWithin(monitor, "auth guard and logout");
  } finally {
    await attachNetworkSummary(testInfo, monitor);
  }
});
