import { expect, test as setup } from "./support/test";
import {
  adminEmail,
  adminPassword,
  adminStorageState,
  expectRenewletSetupPage,
  isProductLoginResponse,
} from "./support/auth";
import { expectLabelControlGap } from "./support/layout";

// setup 项目负责生成后续所有 E2E 复用的管理员 storageState；若这里过早写入，会把半登录态扩散到整套测试。
setup("install admin through Renewlet setup UI", async ({ page }) => {
  await page.goto("/setup");
  await expectRenewletSetupPage(page);
  await expectLabelControlGap(page.getByLabel("显示名称", { exact: true }), "setup name");
  await expectLabelControlGap(page.getByLabel("登录邮箱", { exact: true }), "setup email");
  await expectLabelControlGap(page.getByLabel("密码", { exact: true }), "setup password");

  await page.getByLabel("显示名称", { exact: true }).fill("Admin");
  await page.getByLabel("登录邮箱", { exact: true }).fill(adminEmail);
  await page.getByLabel("密码", { exact: true }).fill("12");
  await page.getByRole("button", { name: "创建管理员" }).click();
  await expect(page.getByText("密码至少需要 8 位")).toBeVisible();

  await page.getByLabel("密码", { exact: true }).fill(adminPassword);
  // 响应等待比只等 URL 更能证明后端完成创建，避免随后登录时撞上初始化竞态。
  const setupResponsePromise = page.waitForResponse((response) =>
    response.url().includes("/api/app/setup") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "创建管理员" }).click();
  const setupResponse = await setupResponsePromise;
  expect(setupResponse.ok(), await setupResponse.text()).toBe(true);
  await expect(page).toHaveURL(/\/login$/);

  await expectLabelControlGap(page.getByLabel("邮箱", { exact: true }), "login email");
  await expectLabelControlGap(page.getByLabel("密码", { exact: true }), "login password");
  await page.getByLabel("邮箱", { exact: true }).fill(adminEmail);
  await page.getByLabel("密码", { exact: true }).fill(adminPassword);
  // storage state 只有在产品登录端点返回成功后才可信；否则会把半登录状态写给业务项目。
  const loginResponsePromise = page.waitForResponse((response) => isProductLoginResponse(response));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse.ok(), await loginResponse.text()).toBe(true);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("月均支出")).toBeVisible();
  // 仅给少数 E2E 内部表 seed 用例提供 collection 写入 token；真实产品 API 认证走 HttpOnly cookie + CSRF。
  const pocketBaseAuth = await page.evaluate(async ({ email, password }) => {
    const response = await fetch("/api/collections/users/auth-with-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: email, password }),
    });
    return {
      body: await response.text(),
      ok: response.ok,
      status: response.status,
    };
  }, { email: adminEmail, password: adminPassword });
  expect(pocketBaseAuth.ok, `seed PocketBase auth state: ${pocketBaseAuth.status} ${pocketBaseAuth.body}`).toBe(true);
  await page.evaluate((body) => {
    window.localStorage.setItem("pocketbase_auth", body);
  }, pocketBaseAuth.body);

  await page.context().storageState({ path: adminStorageState });
});
