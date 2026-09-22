/// <reference types="node" />
import { defineConfig, devices } from "@playwright/test";

const env = process.env;
const cloudflareAuthState = "test-results/cloudflare-check/.auth/admin.json";

function readRequiredBaseURL(): string {
  const raw = env.RENEWLET_E2E_BASE_URL?.trim();
  if (!raw) {
    throw new Error("Cloudflare 巡检需要设置 RENEWLET_E2E_BASE_URL，例如 https://renewlet.example.com");
  }
  const url = new URL(raw);
  return url.toString().replace(/\/$/, "");
}

const baseURL = readRequiredBaseURL();
const hasCredentials = Boolean(env.RENEWLET_E2E_EMAIL?.trim() && env.RENEWLET_E2E_PASSWORD?.trim());

if (!hasCredentials) {
  console.warn("未设置 RENEWLET_E2E_EMAIL / RENEWLET_E2E_PASSWORD，本次只运行公开路由巡检。");
}

export default defineConfig({
  testDir: "./e2e/cloudflare-check",
  outputDir: "test-results/cloudflare-check",
  // 线上巡检串行执行，避免同一个测试账号同时改设置/订阅，导致结果被另一个项目污染。
  fullyParallel: false,
  workers: 1,
  retries: env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/cloudflare-check" }]],
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "cloudflare-public",
      testMatch: "**/public-routes.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    ...(hasCredentials
      ? [
          {
            name: "cloudflare-setup",
            testMatch: "**/auth.setup.ts",
            use: { ...devices["Desktop Chrome"] },
          },
          {
            name: "cloudflare-desktop",
            dependencies: ["cloudflare-setup"],
            testMatch: "**/desktop-site.spec.ts",
            use: {
              ...devices["Desktop Chrome"],
              // 登录态来自真实线上 /login；业务项目不重复登录，专注验证页面和 API 稳定性。
              storageState: cloudflareAuthState,
            },
          },
          {
            name: "cloudflare-mobile",
            dependencies: ["cloudflare-setup"],
            testMatch: "**/mobile-site.spec.ts",
            use: {
              ...devices["Pixel 5"],
              // 移动巡检复用同一 session，专门暴露 viewport/sheet/layout 问题，而不是认证噪音。
              storageState: cloudflareAuthState,
            },
          },
        ]
      : []),
  ],
});
