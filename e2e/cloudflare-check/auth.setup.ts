import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test as setup } from "@playwright/test";
import { loginThroughCloudflareUI } from "./support/auth";
import { cloudflareAuthStatePath } from "./support/env";
import {
  attachNetworkSummary,
  createNetworkMonitor,
  expectNoBlockingNetworkIssues,
  expectNoConcurrentCoreRequests,
  expectNoRepeatedSessionWithin,
} from "./support/network";

setup("login to deployed Cloudflare app", async ({ page }, testInfo) => {
  const monitor = createNetworkMonitor(page);
  try {
    // setup project 只负责获取线上 session；后续 desktop/mobile 共享 storage state，避免重复登录触发限流。
    await loginThroughCloudflareUI(page, "/");
    await expect(page.getByText("月均支出")).toBeVisible();
    await mkdir(dirname(cloudflareAuthStatePath), { recursive: true });
    // 线上 Worker 没有测试专用初始化流程；setup project 只固化临时浏览器登录态给后续项目复用。
    await page.context().storageState({ path: cloudflareAuthStatePath });

    expectNoBlockingNetworkIssues(monitor, "cloudflare login setup");
    expectNoConcurrentCoreRequests(monitor, "cloudflare login setup");
    expectNoRepeatedSessionWithin(monitor, "cloudflare login setup");
  } finally {
    await attachNetworkSummary(testInfo, monitor);
  }
});
