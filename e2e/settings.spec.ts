import { expect, test } from "./support/test";
import {
  captureLayoutSnapshot,
  expectFormFieldRowAlignment,
  expectLabelControlGap,
  expectRootScrollContainer,
  expectStableLayout,
} from "./support/layout";
import {
  deferAdvancedSettingsModule,
  expectSettingsSectionAtScrollAnchor,
  fillChangedTestPhone,
  getSettingsDiscardButton,
  getSettingsSaveButton,
  gotoSettingsAfterHydration,
  gotoSettingsSectionAfterHydration,
} from "./support/settings";

test("desktop passkey fields and add action share stable form tracks", async ({ page }) => {
  await gotoSettingsAfterHydration(page);
  await page.getByRole("button", { name: "管理通行密钥" }).click();

  const dialog = page.getByRole("dialog", { name: "管理通行密钥" });
  const nameInput = dialog.getByLabel("通行密钥名称");
  const row = nameInput.locator('xpath=ancestor::*[@data-slot="form-field-row"][1]');
  await expect(row).toHaveAttribute("data-align-at", "md");
  await expect(row).toHaveAttribute("data-tracks", "3");
  await expectFormFieldRowAlignment(row, "desktop passkey registration", { action: true });
});

test("settings directory locates the skeleton before deferred content commits", async ({ page }) => {
  const advancedModule = await deferAdvancedSettingsModule(page);
  await gotoSettingsAfterHydration(page);
  const desktopNav = page.getByTestId("settings-section-nav-desktop");
  const calendarLink = desktopNav.getByRole("link", { name: "日历订阅" });
  const calendarSection = page.locator("#settings-calendar-feed");

  await calendarLink.click();
  await advancedModule.waitForRequest();

  await expect(page).toHaveURL(/#settings-calendar-feed$/);
  await expect(calendarLink).toHaveAttribute("aria-current", "location");
  await expect(calendarSection).toHaveAttribute("aria-busy", "true");
  await expect(calendarSection).toBeInViewport();

  advancedModule.release();

  await expect(calendarSection).not.toHaveAttribute("aria-busy", "true");
  await expect(calendarSection).toBeInViewport();
  await expectSettingsSectionAtScrollAnchor(calendarSection);
  await expect(page).toHaveURL(/#settings-calendar-feed$/);
  await expect(calendarLink).toHaveAttribute("aria-current", "location");
});

test("settings hash restores through back navigation and refresh", async ({ page }) => {
  await gotoSettingsAfterHydration(page);
  const desktopNav = page.getByTestId("settings-section-nav-desktop");
  const notificationsLink = desktopNav.getByRole("link", { name: "通知" });
  await notificationsLink.click();
  await expect(page).toHaveURL(/#settings-notifications$/);

  await desktopNav.getByRole("link", { name: "时区" }).click();
  await expect(page).toHaveURL(/#settings-timezone$/);
  await page.goBack();
  await expect(page).toHaveURL(/#settings-notifications$/);
  await expect(notificationsLink).toHaveAttribute("aria-current", "location");

  const settingsRead = page.waitForResponse((response) => response.request().method() === "GET" && response.status() === 200 && response.url().includes("/api/app/settings"));
  await page.reload();
  await settingsRead;
  await expect(page).toHaveURL(/#settings-notifications$/);
  await expect(page.locator("#settings-notifications")).toBeInViewport();
});

test("settings save, language switch, and floating layer layout stability", async ({ page }) => {
  await gotoSettingsSectionAfterHydration(page, "settings-notifications");
  await expect(page.getByRole("heading", { name: "系统配置" })).toBeVisible();
  await expectLabelControlGap(page.getByLabel("月度预算金额", { exact: true }), "settings monthly budget");
  await expectLabelControlGap(page.getByLabel("第三方 API 测试号码", { exact: true }), "settings test phone");

  const testPhoneInput = page.getByLabel("第三方 API 测试号码", { exact: true });
  await fillChangedTestPhone(testPhoneInput);
  const saveChangesButton = getSettingsSaveButton(page);
  await expect(saveChangesButton).toBeVisible();
  // 浮层打开后背景可能被 aria-hidden，先保存 ElementHandle 才能比较固定按钮的视觉位置。
  const saveChangesButtonElement = await saveChangesButton.elementHandle();
  if (!saveChangesButtonElement) {
    throw new Error("Missing save button element before opening floating layers");
  }

  const settingsContent = page.getByTestId("settings-main");
  const settingsBeforeSelect = await captureLayoutSnapshot(page, {
    content: settingsContent,
    saveButton: saveChangesButtonElement,
  });
  expectRootScrollContainer(settingsBeforeSelect);

  const languageSelect = page.getByRole("combobox", { name: "语言" });
  await languageSelect.click();
  await expect(page.getByRole("option", { name: "English" })).toBeVisible();
  const settingsWithSelectOpen = await captureLayoutSnapshot(page, {
    content: settingsContent,
    saveButton: saveChangesButtonElement,
  });
  expect(settingsWithSelectOpen.bodyScrollLocked).toBe(true);
  expectRootScrollContainer(settingsWithSelectOpen);
  expectStableLayout(settingsBeforeSelect, settingsWithSelectOpen, "settings language select");

  await page.keyboard.press("Escape");
  await expect(page.getByRole("option", { name: "English" })).toBeHidden();

  await page.getByRole("button", { name: "修改密码" }).click();
  const passwordDialog = page.getByRole("dialog", { name: "修改密码" });
  await expect(passwordDialog).toBeVisible();
  const settingsWithPasswordDialogOpen = await captureLayoutSnapshot(page, {
    content: settingsContent,
    saveButton: saveChangesButtonElement,
  });
  expect(settingsWithPasswordDialogOpen.bodyScrollLocked).toBe(true);
  expectRootScrollContainer(settingsWithPasswordDialogOpen);
  expectStableLayout(settingsBeforeSelect, settingsWithPasswordDialogOpen, "settings password dialog");
  await expectLabelControlGap(passwordDialog.getByLabel("当前密码", { exact: true }), "settings current password");
  await expectLabelControlGap(passwordDialog.getByLabel("新密码", { exact: true }), "settings new password");
  await expectLabelControlGap(passwordDialog.getByLabel("确认密码", { exact: true }), "settings confirm password");

  await passwordDialog.getByRole("button", { name: "Close" }).click();
  await expect(passwordDialog).toBeHidden();
  await saveChangesButton.click();
  await expect(saveChangesButton).toBeHidden();

  await languageSelect.click();
  await page.getByRole("option", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: "System settings" })).toBeVisible();
  await page.getByRole("combobox", { name: "Language" }).click();
  await page.getByRole("option", { name: "Русский" }).click();
  await expect(page.getByRole("heading", { name: "Системные настройки" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ru-RU");
  await page.getByRole("combobox", { name: "Язык" }).click();
  await page.getByRole("option", { name: "中文" }).click();
  await expect(page.getByRole("heading", { name: "系统配置" })).toBeVisible();

  const discardChangesButton = getSettingsDiscardButton(page);
  if (await discardChangesButton.isVisible()) {
    await discardChangesButton.click();
    await expect(discardChangesButton).toBeHidden();
  }
});
