import { expect, type Page } from "@playwright/test";
import { requireCloudflareCredentials } from "./env";
import { isApiResponse } from "./network";

export async function expectLoginForm(page: Page) {
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
  await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
}

export async function loginThroughCloudflareUI(page: Page, nextPath = "/") {
  const { email, password } = requireCloudflareCredentials();
  await page.goto(`/login?next=${encodeURIComponent(nextPath)}`);
  await expectLoginForm(page);
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);

  const loginResponsePromise = page.waitForResponse((response) =>
    isApiResponse(response, "/api/app/auth/login", "POST"),
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse.ok(), await loginResponse.text()).toBe(true);
  // Cloudflare check 后续请求依赖 cookie session；localStorage 只保存非密用户快照，用来确认前端完成登录落盘。
  await expect.poll(async () => page.evaluate(() => {
    const raw = localStorage.getItem("renewlet_app_session");
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      const record = parsed as Record<string, unknown>;
      const value = record["value"];
      return record["version"] === 1 && Boolean(value && typeof value === "object" && "session" in value);
    } catch {
      return false;
    }
  }), { message: "login should persist the Cloudflare session record" }).toBe(true);
  await expect.poll(() => new URL(page.url()).pathname, { message: "login should land on next path" }).toBe(nextPath);
}

export async function logoutThroughCloudflareUI(page: Page) {
  const logoutResponsePromise = page.waitForResponse((response) =>
    isApiResponse(response, "/api/app/auth/logout", "POST"),
  );
  await page.getByRole("button", { name: "退出登录" }).click();
  const logoutResponse = await logoutResponsePromise;
  expect(logoutResponse.ok(), await logoutResponse.text()).toBe(true);
  await expect(page).toHaveURL(/\/login/);
  await expectLoginForm(page);
}
