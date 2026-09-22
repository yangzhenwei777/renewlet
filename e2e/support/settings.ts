import { expect, type Locator, type Page, type Route } from "@playwright/test";

const ADVANCED_SETTINGS_MODULE_ROUTE = "**/settings-advanced-sections.tsx*";

export async function expectSettingsSectionAtScrollAnchor(section: Locator) {
  await expect.poll(() => section.evaluate((element) => {
    const root = document.getElementById("root");
    if (!root) return Number.POSITIVE_INFINITY;
    const scrollMarginTop = Number.parseFloat(window.getComputedStyle(element).scrollMarginTop) || 0;
    return Math.abs(element.getBoundingClientRect().top - root.getBoundingClientRect().top - scrollMarginTop);
  }), { message: "settings section should settle at its scroll-margin anchor" }).toBeLessThanOrEqual(2);
}

export async function deferAdvancedSettingsModule(page: Page) {
  let releaseRequest!: () => void;
  let reportRequest!: () => void;
  let released = false;
  const requestReleased = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const requestObserved = new Promise<void>((resolve) => {
    reportRequest = resolve;
  });
  const holdModuleRequest = async (route: Route) => {
    reportRequest();
    await requestReleased;
    if (page.isClosed()) return;
    await route.continue();
  };
  const release = () => {
    if (released) return;
    released = true;
    releaseRequest();
  };

  await page.route(ADVANCED_SETTINGS_MODULE_ROUTE, holdModuleRequest);
  page.once("close", release);

  return {
    waitForRequest: () => requestObserved,
    release,
  };
}

function extractRemoteTestPhone(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;

  const data = (payload as { data?: unknown }).data;
  const settings = data && typeof data === "object" && !Array.isArray(data)
    ? (data as { settings?: unknown }).settings
    : null;
  const record = settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings
    : Array.isArray((payload as { items?: unknown }).items)
      ? (payload as { items: unknown[] }).items[0]
      : payload;
  if (!record || typeof record !== "object") return null;

  const value = (record as { testPhone?: unknown }).testPhone;
  return typeof value === "string" ? value : null;
}

type SettingsSectionId = "settings-calendar-feed" | "settings-data-config" | "settings-display" | "settings-notifications";

function waitForSettingsRead(page: Page) {
  return page.waitForResponse((response) => (
    response.request().method() === "GET"
    && response.status() === 200
    && response.url().includes("/api/app/settings")
  ));
}

export async function gotoSettingsAfterHydration(page: Page) {
  const settingsRead = waitForSettingsRead(page);
  await page.goto("/settings");
  await settingsRead;
}

export async function gotoSettingsSectionAfterHydration(page: Page, sectionId: SettingsSectionId) {
  // 设置页会先渲染默认值再被远端设置覆盖；E2E 必须等 GET 返回后再断言表单，避免首帧默认值造成 flaky。
  const settingsRead = waitForSettingsRead(page);

  await page.goto(`/settings#${sectionId}`);
  const settingsResponse = await settingsRead;
  const remoteTestPhone = extractRemoteTestPhone(await settingsResponse.json().catch(() => null));
  const section = page.locator(`#${sectionId}`);
  await expect(section).toBeVisible();
  await expect(section).not.toHaveAttribute("aria-busy", "true");

  if (sectionId === "settings-notifications" && remoteTestPhone !== null) {
    const testPhoneInput = page.getByLabel(/^(第三方 API 测试号码|Third-party API test number)$/);
    await expect(testPhoneInput).toHaveValue(remoteTestPhone);
  }
}

export function getSettingsSaveButton(page: Page) {
  // 设置页已有 Turnstile 独立保存/放弃按钮；全局草稿操作必须限定底部保存栏，避免同名按钮误匹配。
  return page.getByTestId("settings-save-bar").getByRole("button", { name: /^(保存更改|Save changes)$/ });
}

export function getSettingsDiscardButton(page: Page) {
  return page.getByTestId("settings-save-bar").getByRole("button", { name: /^(放弃更改|Discard changes)$/ });
}

export async function fillChangedTestPhone(input: Locator) {
  const current = await input.inputValue();
  const next = current === "8613800000000" ? "8613900000000" : "8613800000000";
  await input.fill(next);
  await expect(input).toHaveValue(next);
  return next;
}
