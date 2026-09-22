// H5 基线 E2E 覆盖登录、设置、订阅弹窗、Logo sheet 和 Select sheet，是移动端布局回归的总闸。
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/test";
import {
  createSubscription,
  openAddSubscriptionDialog,
  openSubscriptionEditDialog,
  uniqueE2EName,
} from "./support/subscriptions";
import {
  captureLogoSheetScrollMetrics,
  expectActionNearContainerBottom,
  expectNoHorizontalOverflow,
  expectOverlayLeavesTopScrim,
  expectScrollContentNearFooter,
  expectTouchTarget,
  expectTouchTargetsDoNotOverlap,
  getRequiredLocatorBoundingBox,
} from "./support/layout";
import { installLogoCandidateRoute } from "./support/media-candidates";
import {
  fillChangedTestPhone,
  getSettingsDiscardButton,
  getSettingsSaveButton,
  gotoSettingsSectionAfterHydration,
} from "./support/settings";

async function expectPanelInsideViewport(page: Page, locatorLabel: string) {
  const panel = page.getByRole("dialog").first();
  await expectLocatorInsideViewport(page, panel, locatorLabel);
}

async function expectLocatorInsideViewport(page: Page, locator: Locator, locatorLabel: string) {
  const box = await getRequiredLocatorBoundingBox(locator, locatorLabel);
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error("Missing viewport size");
  }

  expect(box.x, `${locatorLabel}: left edge`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${locatorLabel}: top edge`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${locatorLabel}: right edge`).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height, `${locatorLabel}: bottom edge`).toBeLessThanOrEqual(viewport.height + 1);
}

async function waitForSheetAnimation(sheet: Locator) {
  // Vaul 用 transform 驱动拖拽与进出场；布局断言必须避开动画中的过渡态尺寸。
  await sheet.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function expectMobileSheetVaulChrome(sheet: Locator, label: string) {
  await expect(sheet, `${label}: vaul drawer`).toHaveAttribute("data-vaul-drawer");
  await expect(sheet.locator("[data-vaul-handle]").first(), `${label}: vaul handle`).toBeVisible();
}

async function dragMobileSheetHandleToClose(page: Page, sheet: Locator, label: string) {
  await expectMobileSheetVaulChrome(sheet, label);
  const handle = sheet.locator("[data-vaul-handle]").first();
  const handleBox = await getRequiredLocatorBoundingBox(handle, `${label} handle`);
  const sheetBox = await getRequiredLocatorBoundingBox(sheet, label);
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error("Missing viewport size");
  }

  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const targetY = Math.min(viewport.height - 4, startY + Math.max(180, sheetBox.height * 0.65));
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, targetY, { steps: 10 });
  await page.mouse.up();
  await expect(sheet, `${label}: dragged closed`).toBeHidden();
}

async function captureSearchableSheetListMetrics(sheet: Locator, optionLabel: string) {
  return sheet.evaluate((element, label) => {
    const list = element.querySelector<HTMLElement>("[cmdk-list]");
    const option = Array.from(element.querySelectorAll<HTMLElement>("[cmdk-item]"))
      .find((item) => item.textContent?.includes(label));
    if (!list || !option) {
      throw new Error(`Missing searchable sheet list or option: ${label}`);
    }

    const probe = element.ownerDocument.createElement("span");
    probe.style.color = "hsl(var(--foreground))";
    element.ownerDocument.body.append(probe);
    const foregroundColor = window.getComputedStyle(probe).color;
    probe.remove();

    return {
      sheetHeight: Math.round(element.getBoundingClientRect().height),
      listHeight: Math.round(list.getBoundingClientRect().height),
      optionColor: window.getComputedStyle(option).color,
      optionOpacity: window.getComputedStyle(option).opacity,
      foregroundColor,
      dataDisabled: option.getAttribute("data-disabled"),
      ariaDisabled: option.getAttribute("aria-disabled"),
    };
  }, optionLabel);
}

async function captureMobileSelectSheetMetrics(sheet: Locator, locatorLabel: string) {
  return sheet.evaluate((element, label) => {
    const viewport = element.querySelector<HTMLElement>(".h5-mobile-select-viewport");
    if (!viewport) {
      throw new Error(`Missing mobile select viewport: ${label}`);
    }

    const scrollButtons = Array.from(element.querySelectorAll<HTMLElement>(".h5-mobile-select-scroll-button"));
    const sheetRect = element.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();

    return {
      sheetHeight: Math.round(sheetRect.height),
      viewportHeight: Math.round(viewportRect.height),
      scrollTop: Math.round(viewport.scrollTop),
      scrollHeight: Math.round(viewport.scrollHeight),
      clientHeight: Math.round(viewport.clientHeight),
      scrollButtonDisplays: scrollButtons.map((button) => window.getComputedStyle(button).display),
    };
  }, locatorLabel);
}

async function expectMobileSelectSheetStableWhileScrolling(sheet: Locator, locatorLabel: string) {
  const scrollButtons = sheet.locator(".h5-mobile-select-scroll-button");
  const scrollButtonCount = await scrollButtons.count();
  expect(scrollButtonCount, `${locatorLabel}: Radix mounted at least one scroll affordance`).toBeGreaterThan(0);
  for (let index = 0; index < scrollButtonCount; index += 1) {
    await expect(scrollButtons.nth(index), `${locatorLabel}: mobile scroll button ${index} display`).toHaveCSS(
      "display",
      "none",
    );
  }

  const before = await captureMobileSelectSheetMetrics(sheet, locatorLabel);
  expect(before.scrollHeight, `${locatorLabel}: viewport must be internally scrollable`).toBeGreaterThan(before.clientHeight);

  await sheet.locator(".h5-mobile-select-viewport").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });

  await expect
    .poll(async () => (await captureMobileSelectSheetMetrics(sheet, locatorLabel)).scrollTop)
    .toBeGreaterThan(0);
  const after = await captureMobileSelectSheetMetrics(sheet, locatorLabel);

  expect(Math.abs(after.sheetHeight - before.sheetHeight), `${locatorLabel}: sheet height after scroll`).toBeLessThanOrEqual(1);
  expect(Math.abs(after.viewportHeight - before.viewportHeight), `${locatorLabel}: viewport height after scroll`).toBeLessThanOrEqual(1);
  expect(after.scrollButtonDisplays, `${locatorLabel}: mobile scroll buttons must not affect layout`).toEqual(
    Array.from({ length: after.scrollButtonDisplays.length }, () => "none"),
  );
}

type UploadedLogoRouteRecord = {
  id: string;
  kind: "logo";
  originalName: string;
};

async function captureLogoSheetViewportMetrics(sheet: Locator, viewportTestId: string) {
  return sheet.evaluate((element, testId) => {
    const results = element.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (!results) {
      throw new Error(`Missing Logo sheet viewport: ${testId}`);
    }

    return {
      sheetHeight: Math.round(element.getBoundingClientRect().height),
      resultsHeight: Math.round(results.getBoundingClientRect().height),
    };
  }, viewportTestId);
}

async function installUploadedLogoAssetsRoute(page: Page) {
  let records: UploadedLogoRouteRecord[] = [];

  await page.route("**/api/app/assets?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          page: 1,
          totalPages: records.length > 0 ? 1 : 0,
          items: records.map((record) => ({
            id: record.id,
            url: `/api/app/assets/${record.id}`,
            kind: record.kind,
            originalName: record.originalName,
            mimeType: "image/svg+xml",
            sizeBytes: 128,
            created: "2026-05-18 00:00:00.000Z",
            updated: "2026-05-18 00:00:00.000Z",
          })),
        },
      }),
    });
  });

  await page.route("**/api/app/assets/e2e-logo-1", async (route) => {
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#22c55e"/><path d="M18 34h28v8H18zM18 22h28v8H18z" fill="white"/></svg>',
    });
  });

  return {
    setRecords(nextRecords: UploadedLogoRouteRecord[]) {
      records = nextRecords;
    },
  };
}

async function tapMobileSheetBackdrop(page: Page, absolutePosition?: { x: number; y: number }) {
  const backdrop = page.locator("[data-mobile-overlay-backdrop]").last();
  await expect(backdrop).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-mobile-overlay-open", "");
  if (absolutePosition) {
    await page.touchscreen.tap(absolutePosition.x, absolutePosition.y);
    return;
  }

  const backdropBox = await getRequiredLocatorBoundingBox(backdrop, "mobile sheet backdrop");
  await page.touchscreen.tap(backdropBox.x + 12, backdropBox.y + 12);
}

test.describe("public H5 chrome", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("login and setup routes keep native mobile viewport constraints", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 640 });
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();

    const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(viewportMeta).toContain("viewport-fit=cover");
    expect(viewportMeta).toContain("interactive-widget=resizes-content");
    await expectNoHorizontalOverflow(page, "mobile login");
    const emailInput = page.getByRole("textbox", { name: "邮箱", exact: true });
    await expect(emailInput).toHaveAttribute("inputmode", "email");
    await expect(emailInput).toHaveAttribute("enterkeyhint", "next");
    await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("enterkeyhint", "done");
    await expectTouchTarget(page.getByRole("button", { name: "登录", exact: true }), "login submit");

    await page.goto("/setup");
    await expectNoHorizontalOverflow(page, "mobile setup completed state");
  });
});

const H5_CORE_VIEWPORT_MATRIX = [
  { width: 360, height: 740, label: "narrow" },
  { width: 390, height: 720, label: "baseline" },
  { width: 430, height: 760, label: "large phone" },
  { width: 640, height: 360, label: "landscape" },
  { width: 900, height: 700, label: "tablet" },
] as const;

const H5_CORE_ROUTES = [
  { path: "/", label: "dashboard" },
  { path: "/subscriptions", label: "subscriptions" },
  { path: "/calendar", label: "calendar" },
  { path: "/statistics", label: "statistics" },
  { path: "/settings", label: "settings" },
] as const;

// 每个 viewport 独立占用测试预算，避免跨路由导航的累计耗时把 runner 波动误判成布局回归。
for (const viewport of H5_CORE_VIEWPORT_MATRIX) {
  test(
    `core authenticated H5 pages do not overflow at ${viewport.label} ${viewport.width}x${viewport.height}`,
    async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      for (const route of H5_CORE_ROUTES) {
        await test.step(`${route.label} ${route.path}`, async () => {
          await page.goto(route.path);
          await expect(page.getByTestId("app-header")).toBeVisible();
          await expectNoHorizontalOverflow(page, `${viewport.label} ${route.label}`);
        });
      }
    },
  );
}

test("short H5 viewport keeps dialogs and bottom actions operable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 560 });

  await page.goto("/subscriptions");
  const subscriptionDialog = await openAddSubscriptionDialog(page);
  await expectPanelInsideViewport(page, "subscription dialog");
  await expectNoHorizontalOverflow(page, "mobile subscription dialog");
  const cancelSubscriptionButton = subscriptionDialog.getByRole("button", { name: "取消" });
  const submitSubscriptionButton = subscriptionDialog.getByRole("button", { name: "添加订阅" });
  await expectTouchTarget(cancelSubscriptionButton, "subscription dialog cancel");
  await expectTouchTarget(submitSubscriptionButton, "subscription dialog submit");
  await expectTouchTargetsDoNotOverlap(
    cancelSubscriptionButton,
    submitSubscriptionButton,
    "subscription dialog actions",
  );
  await expectActionNearContainerBottom(
    subscriptionDialog,
    subscriptionDialog.getByRole("button", { name: "添加订阅" }),
    "mobile subscription dialog submit",
  );
  await expectScrollContentNearFooter(
    subscriptionDialog.locator("[data-subscription-dialog-scroll]"),
    "mobile subscription dialog scroll end",
  );
  await subscriptionDialog.getByRole("button", { name: "取消" }).click();
  await expect(subscriptionDialog).toBeHidden();

  await gotoSettingsSectionAfterHydration(page, "settings-notifications");
  const testPhoneInput = page.getByLabel("第三方 API 测试号码", { exact: true });
  await fillChangedTestPhone(testPhoneInput);
  const saveButton = getSettingsSaveButton(page);
  const discardButton = getSettingsDiscardButton(page);
  await expect(saveButton).toBeVisible();
  await expect(discardButton).toBeVisible();
  await expectTouchTarget(saveButton, "settings save button");
  await expectTouchTarget(discardButton, "settings discard button");
  await expectTouchTargetsDoNotOverlap(saveButton, discardButton, "settings bottom actions");
  await expectNoHorizontalOverflow(page, "mobile settings bottom bar");
});

test("mobile sheets keep Logo and currency search stable while typing", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 640 });
  const uploadedLogoAssetsRoute = await installUploadedLogoAssetsRoute(page);
  await installLogoCandidateRoute(page);

  await page.goto("/subscriptions");
  const addDialog = await openAddSubscriptionDialog(page);
  await addDialog.getByRole("button", { name: "已上传" }).click();
  const emptyUploadedLogoSheet = page.getByTestId("uploaded-logo-sheet");
  await expect(emptyUploadedLogoSheet).toBeVisible();
  await expect(emptyUploadedLogoSheet).toHaveClass(/h5-logo-sheet/);
  await expect(emptyUploadedLogoSheet).toHaveClass(/h5-mobile-sheet-large/);
  await waitForSheetAnimation(emptyUploadedLogoSheet);
  await expect(emptyUploadedLogoSheet.getByText("还没有上传过自定义 Logo")).toBeVisible();
  const uploadedLogoSheetEmpty = await captureLogoSheetViewportMetrics(
    emptyUploadedLogoSheet,
    "uploaded-logo-results",
  );
  await page.keyboard.press("Escape");
  await expect(emptyUploadedLogoSheet).toBeHidden();

  uploadedLogoAssetsRoute.setRecords([
    {
      id: "e2e-logo-1",
      kind: "logo",
      originalName: "stable-logo.svg",
    },
  ]);
  await addDialog.getByRole("button", { name: "已上传" }).click();
  const filledUploadedLogoSheet = page.getByTestId("uploaded-logo-sheet");
  await expect(filledUploadedLogoSheet.getByRole("button", { name: "stable-logo.svg" })).toBeVisible();
  const uploadedLogoSheetFilled = await captureLogoSheetViewportMetrics(
    filledUploadedLogoSheet,
    "uploaded-logo-results",
  );
  expect(
    Math.abs(uploadedLogoSheetFilled.sheetHeight - uploadedLogoSheetEmpty.sheetHeight),
    "uploaded Logo sheet height should stay fixed between empty and filled states",
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(uploadedLogoSheetFilled.resultsHeight - uploadedLogoSheetEmpty.resultsHeight),
    "uploaded Logo viewport should stay fixed between empty and filled states",
  ).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(filledUploadedLogoSheet).toBeHidden();

  await addDialog.getByRole("button", { name: "搜索" }).click();

  const emptyLogoSheet = page.getByTestId("logo-search-sheet");
  await expect(emptyLogoSheet).toBeVisible();
  await expect(emptyLogoSheet).toHaveClass(/h5-logo-search-sheet/);
  await expect(emptyLogoSheet).toHaveClass(/h5-mobile-sheet-large/);
  await waitForSheetAnimation(emptyLogoSheet);
  await expectLocatorInsideViewport(page, emptyLogoSheet, "mobile empty logo search sheet");
  await expect(emptyLogoSheet.getByText("输入服务名称、品牌或网址后点击搜索")).toBeVisible();
  const logoSheetBeforeSearch = await captureLogoSheetViewportMetrics(emptyLogoSheet, "logo-search-results");

  const emptyLogoSearchInput = emptyLogoSheet.getByPlaceholder("输入服务名称、品牌或网址...");
  await emptyLogoSearchInput.focus();
  const focusState = await emptyLogoSheet.evaluate((element) => {
    const panel = element.querySelector<HTMLElement>(".media-candidate-search-panel");
    const input = element.querySelector<HTMLInputElement>('input[placeholder="输入服务名称、品牌或网址..."]');
    if (!panel || !input) {
      throw new Error("Missing Logo search panel or input");
    }

    return {
      panelOverflow: window.getComputedStyle(panel).overflow,
      inputLeftInset: Math.round(input.getBoundingClientRect().left - element.getBoundingClientRect().left),
    };
  });
  expect(focusState.panelOverflow, "Logo search panel should not clip the focused input ring").toBe("visible");
  expect(focusState.inputLeftInset, "Logo search input should keep visible left focus inset").toBeGreaterThan(12);
  await emptyLogoSearchInput.fill("Linear");
  await emptyLogoSearchInput.press("Enter");
  await expect(emptyLogoSheet.getByRole("button", { name: /Linear 1/ }).first()).toBeVisible({ timeout: 10_000 });
  const logoSheetAfterSearch = await captureLogoSheetViewportMetrics(emptyLogoSheet, "logo-search-results");
  expect(
    Math.abs(logoSheetAfterSearch.sheetHeight - logoSheetBeforeSearch.sheetHeight),
    "Logo search sheet height should stay fixed between prompt and results",
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(logoSheetAfterSearch.resultsHeight - logoSheetBeforeSearch.resultsHeight),
    "Logo search results viewport should stay fixed between prompt and results",
  ).toBeLessThanOrEqual(1);
  await expectLocatorInsideViewport(page, emptyLogoSheet, "mobile logo search sheet after results");
  const addLogoScroll = await captureLogoSheetScrollMetrics(emptyLogoSheet, "logo-search-results");
  expect(addLogoScroll.scrollHeight, "add Logo search results should overflow with many candidates").toBeGreaterThan(
    addLogoScroll.clientHeight,
  );
  expect(addLogoScroll.scrollTop, JSON.stringify(addLogoScroll, null, 2)).toBeGreaterThanOrEqual(
    addLogoScroll.scrollHeight - addLogoScroll.clientHeight - 1,
  );
  expect(addLogoScroll.lastBottomGap, JSON.stringify(addLogoScroll, null, 2)).toBeGreaterThanOrEqual(8);
  await page.keyboard.press("Escape");
  await expect(emptyLogoSheet).toBeHidden();
  await addDialog.getByRole("button", { name: "取消" }).click();
  await expect(addDialog).toBeHidden();

  const subscriptionName = uniqueE2EName(testInfo, "Mobile Overlay");
  await createSubscription(page, {
    name: subscriptionName,
    price: "16",
    currencyLabel: "USD",
  });

  const editDialog = await openSubscriptionEditDialog(page, subscriptionName);
  await editDialog.getByRole("button", { name: "搜索" }).click();

  const logoSheet = page.getByTestId("logo-search-sheet");
  await expect(logoSheet).toBeVisible();
  await expect(logoSheet).toHaveClass(/h5-mobile-sheet-content/);
  await expectMobileSheetVaulChrome(logoSheet, "mobile logo search sheet");
  await waitForSheetAnimation(logoSheet);
  await expectLocatorInsideViewport(page, logoSheet, "mobile logo search sheet");
  await expectNoHorizontalOverflow(page, "mobile logo search sheet");

  const logoSearchInput = logoSheet.getByPlaceholder("输入服务名称、品牌或网址...");
  await logoSearchInput.fill("Linear");
  await logoSearchInput.press("Enter");
  await expect(logoSearchInput).toHaveValue("Linear");
  await expect(logoSheet.getByRole("button", { name: /Linear 1/ }).first()).toBeVisible({ timeout: 10_000 });
  await expectLocatorInsideViewport(page, logoSheet, "mobile logo search sheet after input");
  const editLogoScroll = await captureLogoSheetScrollMetrics(logoSheet, "logo-search-results");
  expect(editLogoScroll.scrollHeight, "edit Logo search results should overflow with many candidates").toBeGreaterThan(
    editLogoScroll.clientHeight,
  );
  expect(editLogoScroll.scrollTop, JSON.stringify(editLogoScroll, null, 2)).toBeGreaterThanOrEqual(
    editLogoScroll.scrollHeight - editLogoScroll.clientHeight - 1,
  );
  expect(editLogoScroll.lastBottomGap, JSON.stringify(editLogoScroll, null, 2)).toBeGreaterThanOrEqual(8);

  await page.keyboard.press("Escape");
  await expect(logoSheet).toBeHidden();

  const rootScrollBefore = await page.evaluate(() => document.getElementById("root")?.scrollTop ?? 0);
  await editDialog.getByRole("combobox", { name: "选择货币" }).click();
  const currencySheet = page.getByTestId("searchable-select-sheet");
  await expect(currencySheet).toBeVisible();
  await expect(currencySheet).toHaveClass(/h5-mobile-sheet-content/);
  await expectMobileSheetVaulChrome(currencySheet, "mobile currency sheet");
  await waitForSheetAnimation(currencySheet);
  await expectLocatorInsideViewport(page, currencySheet, "mobile currency sheet");
  const currencySheetBeforeFilter = await captureSearchableSheetListMetrics(currencySheet, "USD");

  const bodyScrollLocked = await page.evaluate(() => document.body.hasAttribute("data-scroll-locked"));
  expect(bodyScrollLocked).toBe(true);
  await currencySheet.getByPlaceholder("搜索货币、代码或符号...").fill("USD");
  await expect(currencySheet.getByText("USD", { exact: false }).first()).toBeVisible();
  const currencySheetAfterFilter = await captureSearchableSheetListMetrics(currencySheet, "USD");
  expect(
    Math.abs(currencySheetAfterFilter.sheetHeight - currencySheetBeforeFilter.sheetHeight),
    "searchable sheet height should stay stable while filtering",
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(currencySheetAfterFilter.listHeight - currencySheetBeforeFilter.listHeight),
    "searchable sheet list height should stay stable while filtering",
  ).toBeLessThanOrEqual(1);
  expect(currencySheetAfterFilter.optionColor, "enabled searchable option text color").toBe(
    currencySheetAfterFilter.foregroundColor,
  );
  expect(currencySheetAfterFilter.optionOpacity, "enabled searchable option opacity").toBe("1");
  expect(currencySheetAfterFilter.dataDisabled, "enabled searchable option data-disabled").not.toBe("true");
  expect(currencySheetAfterFilter.ariaDisabled, "enabled searchable option aria-disabled").not.toBe("true");
  await page.mouse.wheel(0, 600);
  const rootScrollAfter = await page.evaluate(() => document.getElementById("root")?.scrollTop ?? 0);
  expect(rootScrollAfter, "root scroll should stay locked behind mobile currency sheet").toBe(rootScrollBefore);

  await currencySheet.getByText("USD", { exact: false }).first().click();
  await expect(currencySheet).toBeHidden();
  await editDialog.getByRole("button", { name: "取消" }).click();
  await expect(editDialog).toBeHidden();
});

test("mobile import Logo editor keeps search candidates scrollable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await installLogoCandidateRoute(page);

  await page.goto("/subscriptions");
  await page.getByRole("button", { name: "导入数据" }).click();
  const importDialog = page.getByRole("dialog", { name: "导入数据" });
  await expect(importDialog).toBeVisible();

  await importDialog.getByRole("tab", { name: "粘贴 JSON" }).click();
  await importDialog.getByPlaceholder("粘贴 Renewlet 或 Wallos JSON...").fill(JSON.stringify([{
    Name: "Linear",
    "Payment Cycle": "Monthly",
    "Next Payment": "2026-06-01",
    Price: "$10",
    Category: "Software",
    "Payment Method": "Visa",
  }]));
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/api/app/import/preview") && response.request().method() === "POST",
    ),
    importDialog.getByRole("button", { name: "生成预览" }).click(),
  ]);

  await importDialog.getByRole("button", { name: "修改 Logo" }).first().click();
  const importLogoSheet = page.locator(".h5-import-logo-sheet");
  await expect(importLogoSheet).toBeVisible();
  await expect(importLogoSheet).toHaveClass(/h5-logo-sheet/);
  await expect(importLogoSheet).toHaveClass(/h5-mobile-sheet-large/);
  await expectMobileSheetVaulChrome(importLogoSheet, "import Logo sheet");
  await waitForSheetAnimation(importLogoSheet);
  await expect(importLogoSheet.getByRole("button", { name: /Linear 1/ }).first()).toBeVisible({ timeout: 10_000 });

  const importLogoScroll = await captureLogoSheetScrollMetrics(importLogoSheet, null);
  expect(importLogoScroll.scrollHeight, "import Logo search results should overflow with many candidates").toBeGreaterThan(
    importLogoScroll.clientHeight,
  );
  expect(importLogoScroll.scrollTop, JSON.stringify(importLogoScroll, null, 2)).toBeGreaterThanOrEqual(
    importLogoScroll.scrollHeight - importLogoScroll.clientHeight - 1,
  );
  expect(importLogoScroll.lastBottomGap, JSON.stringify(importLogoScroll, null, 2)).toBeGreaterThanOrEqual(8);
});

test("mobile option sheets use consistent detents and do not leak backdrop events", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });

  await gotoSettingsSectionAfterHydration(page, "settings-display");
  await page.getByRole("combobox", { name: "语言" }).click();
  const languageSheet = page.locator(".h5-mobile-sheet-content").filter({ hasText: "English" }).last();
  await expect(languageSheet).toBeVisible();
  await expect(languageSheet).toHaveAttribute("data-mobile-detent", "compact");
  await expectMobileSheetVaulChrome(languageSheet, "language compact sheet");
  await waitForSheetAnimation(languageSheet);
  const languageSheetBox = await getRequiredLocatorBoundingBox(languageSheet, "language compact sheet");
  expect(languageSheetBox.height, "language compact sheet should not collapse to a tiny strip").toBeGreaterThan(180);
  await page.keyboard.press("Escape");
  await expect(languageSheet).toBeHidden();

  await page.goto("/subscriptions");
  await page.getByTestId("mobile-category-filter").getByRole("button", { name: "分类" }).click();
  const categoryDrawer = page.getByRole("dialog", { name: "筛选分类" });
  await expect(categoryDrawer).toBeVisible();
  await expect(categoryDrawer).toHaveAttribute("data-vaul-drawer", "");
  await expectMobileSheetVaulChrome(categoryDrawer, "category drawer");
  await waitForSheetAnimation(categoryDrawer);
  await expectOverlayLeavesTopScrim(page, categoryDrawer, "category drawer");
  await expectLocatorInsideViewport(page, categoryDrawer, "category drawer");
  await expectNoHorizontalOverflow(page, "category drawer");
  await page.keyboard.press("Escape");
  await expect(categoryDrawer).toBeHidden();

  await page.getByRole("combobox").filter({ hasText: "所有状态" }).click();
  const subscriptionsStatusSheet = page.locator(".h5-mobile-sheet-content").filter({ hasText: "已过期" }).last();
  await expect(subscriptionsStatusSheet).toBeVisible();
  await expect(subscriptionsStatusSheet).toHaveAttribute("data-mobile-detent", "compact");
  await dragMobileSheetHandleToClose(page, subscriptionsStatusSheet, "subscriptions status filter sheet");

  await page.getByRole("combobox").filter({ hasText: "所有付费类型" }).click();
  const subscriptionsPaymentTypeSheet = page.locator(".h5-mobile-sheet-content").filter({ hasText: "固定服务期" }).last();
  await expect(subscriptionsPaymentTypeSheet).toBeVisible();
  await expect(subscriptionsPaymentTypeSheet).toHaveAttribute("data-mobile-detent", "compact");
  await expect(subscriptionsPaymentTypeSheet.getByRole("option", { name: "自动续费" })).toBeVisible();
  await expect(subscriptionsPaymentTypeSheet.getByRole("option", { name: "手动续费" })).toBeVisible();
  await expect(subscriptionsPaymentTypeSheet.getByRole("option", { name: "长期有效" })).toBeVisible();
  await expect(subscriptionsPaymentTypeSheet.getByRole("option", { name: "固定服务期" })).toBeVisible();
  await dragMobileSheetHandleToClose(page, subscriptionsPaymentTypeSheet, "subscriptions payment type filter sheet");

  await page.getByTestId("mobile-payment-type-sort-row").getByRole("combobox", { name: "排序" }).click();
  const subscriptionsSortSheet = page.locator(".h5-mobile-sheet-content").filter({ hasText: "到期最近" }).last();
  await expect(subscriptionsSortSheet).toBeVisible();
  await expect(subscriptionsSortSheet).toHaveAttribute("data-mobile-detent", "compact");
  await dragMobileSheetHandleToClose(page, subscriptionsSortSheet, "subscriptions sort filter sheet");

  await page.setViewportSize({ width: 390, height: 740 });
  const dialog = await openAddSubscriptionDialog(page);
  const currencyTrigger = dialog.getByRole("combobox", { name: "选择货币" });
  await currencyTrigger.scrollIntoViewIfNeeded();
  const statusTrigger = dialog.getByRole("combobox").filter({ hasText: "活跃" });
  await statusTrigger.scrollIntoViewIfNeeded();
  const currencyBox = await getRequiredLocatorBoundingBox(currencyTrigger, "currency trigger under status backdrop");
  const currencyTapPoint = {
    x: currencyBox.x + currencyBox.width / 2,
    y: currencyBox.y + currencyBox.height / 2,
  };
  await statusTrigger.click();
  const statusSheet = page.locator(".h5-mobile-sheet-content").filter({ hasText: "活跃" }).last();
  await expect(statusSheet).toBeVisible();
  await expectMobileSheetVaulChrome(statusSheet, "dialog status sheet");
  const statusSheetBox = await getRequiredLocatorBoundingBox(statusSheet, "status sheet");
  expect(
    currencyTapPoint.y,
    "currency trigger coordinate must hit the backdrop, not the visible status sheet",
  ).toBeLessThan(statusSheetBox.y);
  await tapMobileSheetBackdrop(page, currencyTapPoint);
  await expect(statusSheet).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(page.locator(".h5-mobile-sheet-content")).toHaveCount(0);
  await expect(page.getByTestId("searchable-select-sheet")).toHaveCount(0);

  const paymentTrigger = dialog.getByRole("combobox").filter({ hasText: "选择支付方式" });
  await paymentTrigger.scrollIntoViewIfNeeded();
  await paymentTrigger.click();
  const paymentSheet = page.locator(".h5-mobile-sheet-content").filter({ hasText: "支付宝" }).last();
  await expect(paymentSheet).toBeVisible();
  await expectMobileSheetVaulChrome(paymentSheet, "dialog payment sheet");
  await tapMobileSheetBackdrop(page);
  await expect(paymentSheet).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(page.locator(".h5-mobile-sheet-content")).toHaveCount(0);

  const reminderTrigger = dialog.getByRole("combobox").filter({ hasText: "提前 3 天" });
  await reminderTrigger.scrollIntoViewIfNeeded();
  await reminderTrigger.click();
  const reminderSheet = page.locator(".h5-mobile-sheet-content").filter({ hasText: "自定义天数" }).last();
  await expect(reminderSheet).toBeVisible();
  await expectMobileSheetVaulChrome(reminderSheet, "dialog reminder sheet");
  await tapMobileSheetBackdrop(page);
  await expect(reminderSheet).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(page.locator(".h5-mobile-sheet-content")).toHaveCount(0);

  await dialog.getByText("日期设置").scrollIntoViewIfNeeded();
  await dialog.getByRole("button", { name: /选择日期/ }).first().click();
  const calendarSheet = page.locator(".h5-mobile-sheet-calendar").last();
  await expect(calendarSheet).toBeVisible();
  await expectMobileSheetVaulChrome(calendarSheet, "dialog calendar sheet");
  await expect(calendarSheet.getByRole("grid")).toBeVisible();
  const calendarGrid = await calendarSheet.evaluate((element) => {
    const sheetRect = element.getBoundingClientRect();
    const firstWeek = element.querySelector<HTMLElement>(".h5-calendar-week");
    if (!firstWeek) {
      throw new Error("Missing mobile calendar week");
    }
    const cells = Array.from(firstWeek.querySelectorAll<HTMLElement>(".h5-calendar-day"));
    if (cells.length !== 7) {
      throw new Error(`Expected 7 calendar cells, got ${cells.length}`);
    }
    const firstCell = cells[0].getBoundingClientRect();
    const lastCell = cells[6].getBoundingClientRect();
    return {
      leftInset: Math.round(firstCell.left - sheetRect.left),
      rightInset: Math.round(sheetRect.right - lastCell.right),
    };
  });
  expect(calendarGrid.rightInset, "calendar should not leave a large blank area on the right").toBeLessThan(48);
  expect(calendarGrid.leftInset, "calendar should keep normal left padding").toBeLessThan(48);
  await calendarSheet.locator(".h5-calendar-day-button:not([disabled])").filter({ hasText: /^18$/ }).first().click();
  await expect(calendarSheet).toBeHidden();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();
});
