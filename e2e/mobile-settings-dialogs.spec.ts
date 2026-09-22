// 移动端设置/订阅弹窗测试覆盖 visualViewport、软键盘和 Radix 动画交界；这些问题只有真实浏览器布局能暴露。
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { expectFormFieldRowStacked, expectNoHorizontalOverflow } from "./support/layout";
import { gotoSettingsAfterHydration, gotoSettingsSectionAfterHydration } from "./support/settings";
import { expectSideDrawerExitLifecycle } from "./support/side-drawer";
import {
  createSubscription,
  openAddSubscriptionDialog,
  openSubscriptionEditDialog,
  uniqueE2EName,
} from "./support/subscriptions";

const VIEWPORT_SYNC_SETTLE_MS = 540;
const CURRENCY_MANAGER_SELECTORS = {
  footer: "[data-settings-manager-footer]",
  header: "[data-settings-manager-header]",
  scrollRegion: "[data-config-manager-scroll]",
} as const;

test("mobile passkey fields keep DOM order without horizontal overflow", async ({ page }) => {
  await gotoSettingsAfterHydration(page);
  await page.getByRole("button", { name: "管理通行密钥" }).click();

  const dialog = page.getByRole("dialog", { name: "管理通行密钥" });
  const row = dialog.getByLabel("通行密钥名称").locator('xpath=ancestor::*[@data-slot="form-field-row"][1]');
  await expect(row).toHaveAttribute("data-align-at", "md");
  await expect(row).toHaveAttribute("data-tracks", "3");
  await expectFormFieldRowStacked(row, "mobile passkey registration");
  await expectNoHorizontalOverflow(page, "mobile passkey manager");
});

test("mobile settings navigation completes the left-side exit lifecycle", async ({ page }) => {
  await gotoSettingsSectionAfterHydration(page, "settings-display");

  const trigger = page.getByTestId("settings-mobile-page-header")
    .getByRole("button", { name: "打开设置目录" });
  await trigger.click();
  const panel = page.getByTestId("settings-section-nav-drawer");
  await expect(panel).toBeVisible();

  await expectSideDrawerExitLifecycle(
    page,
    panel,
    () => panel.getByRole("button", { name: "关闭" }).click(),
  );
  await expect(trigger).toBeFocused();
});

async function setVisualViewportVars(page: Page, height: number, offsetTop = 0) {
  // 先驱动 visualViewport 同步器，再固定本轮测试变量；恢复阶段不能继承上一轮键盘高度。
  await page.evaluate(({ nextHeight, nextOffsetTop }) => {
    const writeRootVars = () => {
      document.documentElement.style.setProperty("--app-layout-viewport-height", "640px");
      document.documentElement.style.setProperty("--app-visual-viewport-offset-top", `${nextOffsetTop}px`);
      document.documentElement.style.setProperty("--app-visual-viewport-offset-left", "0px");
      document.documentElement.style.setProperty("--app-viewport-height", `${nextHeight}px`);
    };

    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      writeRootVars();
      return;
    }

    Object.defineProperties(visualViewport, {
      height: { configurable: true, get: () => nextHeight },
      offsetLeft: { configurable: true, get: () => 0 },
      offsetTop: { configurable: true, get: () => nextOffsetTop },
    });
    visualViewport.dispatchEvent(new Event("resize"));
    visualViewport.dispatchEvent(new Event("scroll"));
    writeRootVars();
  }, { nextHeight: height, nextOffsetTop: offsetTop });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  }));
  await page.evaluate(({ nextHeight, nextOffsetTop }) => {
    document.documentElement.style.setProperty("--app-layout-viewport-height", "640px");
    document.documentElement.style.setProperty("--app-visual-viewport-offset-top", `${nextOffsetTop}px`);
    document.documentElement.style.setProperty("--app-visual-viewport-offset-left", "0px");
    document.documentElement.style.setProperty("--app-viewport-height", `${nextHeight}px`);
  }, { nextHeight: height, nextOffsetTop: offsetTop });
}

async function waitForDialogLayout(dialog: Locator) {
  // Radix 动画结束后还需要两个 rAF 等待 CSS var 参与布局，减少高度断言的亚帧抖动。
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: false }).map((animation) => (
      animation.finished.catch(() => undefined)
    )));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  });
}

async function captureDialogMetrics(
  dialog: Locator,
  selectors: { footer: string; header: string; scrollRegion: string },
) {
  return dialog.evaluate((element, targetSelectors) => {
    const header = element.querySelector<HTMLElement>(targetSelectors.header);
    const scrollRegion = element.querySelector<HTMLElement>(targetSelectors.scrollRegion);
    const footer = element.querySelector<HTMLElement>(targetSelectors.footer);
    if (!header || !scrollRegion || !footer) {
      throw new Error("Missing dialog header, scroll region, or footer");
    }

    const rootStyle = window.getComputedStyle(document.documentElement);
    const viewportHeight = Number.parseFloat(rootStyle.getPropertyValue("--app-viewport-height")) || window.innerHeight;
    const viewportOffsetTop = Number.parseFloat(rootStyle.getPropertyValue("--app-visual-viewport-offset-top")) || 0;
    const panelRect = element.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const scrollRect = scrollRegion.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const panelStyle = window.getComputedStyle(element);
    const scrollStyle = window.getComputedStyle(scrollRegion);
    const appRoot = document.querySelector<HTMLElement>("#root");
    return {
      appRootScrollTop: appRoot?.scrollTop ?? 0,
      documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
      footerTop: Math.round(footerRect.top),
      panelBottom: Math.round(panelRect.bottom),
      panelDisplay: panelStyle.display,
      panelHeight: Math.round(panelRect.height),
      panelScrollTop: element.scrollTop,
      panelTop: Math.round(panelRect.top),
      footerBottom: Math.round(footerRect.bottom),
      footerHeight: Math.round(footerRect.height),
      headerBottom: Math.round(headerRect.bottom),
      headerTop: Math.round(headerRect.top),
      rootViewportHeight: rootStyle.getPropertyValue("--app-viewport-height").trim(),
      scrollBottom: Math.round(scrollRect.bottom),
      scrollClientHeight: scrollRegion.clientHeight,
      scrollHeight: scrollRegion.scrollHeight,
      scrollOverflowY: scrollStyle.overflowY,
      scrollTop: scrollRegion.scrollTop,
      visualViewportBottom: Math.round(viewportOffsetTop + viewportHeight),
    };
  }, selectors);
}

async function expectDialogChromeFixedWhileBodyScrolls(
  dialog: Locator,
  selectors: { footer: string; header: string; scrollRegion: string },
  label: string,
) {
  await waitForDialogLayout(dialog);
  const before = await captureDialogMetrics(dialog, selectors);
  const after = await dialog.evaluate((element, targetSelectors) => {
    const header = element.querySelector<HTMLElement>(targetSelectors.header);
    const scrollRegion = element.querySelector<HTMLElement>(targetSelectors.scrollRegion);
    const footer = element.querySelector<HTMLElement>(targetSelectors.footer);
    if (!header || !scrollRegion || !footer) {
      throw new Error("Missing dialog chrome or body");
    }

    scrollRegion.scrollTop = scrollRegion.scrollHeight;
    const headerRect = header.getBoundingClientRect();
    const panelRect = element.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const appRoot = document.querySelector<HTMLElement>("#root");
    return {
      appRootScrollTop: appRoot?.scrollTop ?? 0,
      documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
      footerTop: Math.round(footerRect.top),
      headerTop: Math.round(headerRect.top),
      panelScrollTop: element.scrollTop,
      panelTop: Math.round(panelRect.top),
      scrollTop: Math.round(scrollRegion.scrollTop),
    };
  }, selectors);

  expect(before.panelDisplay, `${label} panel owns a grid frame`).toBe("grid");
  expect(["auto", "scroll"], `${label} body is the only scrollable region`).toContain(before.scrollOverflowY);
  expect(before.scrollBottom, `${label} body ends before the footer row`).toBeLessThanOrEqual(before.footerTop + 1);
  expect(after.scrollTop, `${label} body owns scrolling`).toBeGreaterThan(0);
  expect(after.panelScrollTop, `${label} panel itself does not scroll`).toBe(0);
  expect(after.appRootScrollTop, `${label} page root does not move`).toBe(before.appRootScrollTop);
  expect(after.documentScrollTop, `${label} document does not move`).toBe(before.documentScrollTop);
  expect(Math.abs(after.panelTop - before.panelTop), `${label} panel stays fixed while body scrolls`)
    .toBeLessThanOrEqual(1);
  expect(Math.abs(after.headerTop - before.headerTop), `${label} header stays fixed while body scrolls`)
    .toBeLessThanOrEqual(1);
  expect(Math.abs(after.footerTop - before.footerTop), `${label} footer stays fixed while body scrolls`)
    .toBeLessThanOrEqual(1);
}

async function expectSubscriptionDialogAdaptsToKeyboardViewport(
  page: Page,
  dialog: Locator,
  label: string,
) {
  await expect(dialog).toHaveClass(/h5-subscription-dialog-panel/);
  const nameInput = dialog.getByLabel("服务名称", { exact: true });
  await nameInput.focus();
  const focusSettledAt = await page.evaluate(() => performance.now());
  await expect.poll(async () => page.evaluate((startedAt) => performance.now() - startedAt, focusSettledAt))
    .toBeGreaterThan(VIEWPORT_SYNC_SETTLE_MS);

  await setVisualViewportVars(page, 360, 180);
  await expect.poll(async () => (await captureDialogMetrics(dialog, {
    footer: "[data-subscription-dialog-footer]",
    header: "[data-subscription-dialog-header]",
    scrollRegion: "[data-subscription-dialog-scroll]",
  })).panelHeight).toBeLessThanOrEqual(328);
  const compact = await captureDialogMetrics(dialog, {
    footer: "[data-subscription-dialog-footer]",
    header: "[data-subscription-dialog-header]",
    scrollRegion: "[data-subscription-dialog-scroll]",
  });

  expect(compact.panelTop, `${label} dialog follows positive visual viewport offset`).toBeGreaterThanOrEqual(180);
  expect(compact.headerTop, `${label} header stays inside compact visual viewport`).toBeGreaterThanOrEqual(180);
  expect(compact.footerBottom, `${label} footer stays inside compact visual viewport`).toBeLessThanOrEqual(
    compact.visualViewportBottom + 1,
  );
  expect(compact.scrollHeight, `${label} form keeps the overflow in the scroll region`).toBeGreaterThan(
    compact.scrollClientHeight,
  );
  await expectDialogChromeFixedWhileBodyScrolls(dialog, {
    footer: "[data-subscription-dialog-footer]",
    header: "[data-subscription-dialog-header]",
    scrollRegion: "[data-subscription-dialog-scroll]",
  }, label);

  await setVisualViewportVars(page, 640);
  const restored = await captureDialogMetrics(dialog, {
    footer: "[data-subscription-dialog-footer]",
    header: "[data-subscription-dialog-header]",
    scrollRegion: "[data-subscription-dialog-scroll]",
  });
  expect(restored.footerBottom, `${label} footer remains visible after keyboard close`).toBeLessThanOrEqual(
    restored.visualViewportBottom + 1,
  );
}

test("mobile currency manager keeps footer visible after keyboard viewport changes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await gotoSettingsSectionAfterHydration(page, "settings-data-config");

  const trigger = page.getByRole("button", { name: /货币管理/ });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "货币管理" });
  await expect(dialog).toBeVisible();
  await expectNoHorizontalOverflow(page, "mobile currency manager dialog");

  const initial = await captureDialogMetrics(dialog, CURRENCY_MANAGER_SELECTORS);
  expect(initial.scrollHeight, "currency list should own the overflow").toBeGreaterThan(initial.scrollClientHeight);
  expect(initial.footerBottom, "currency footer starts inside the panel").toBeLessThanOrEqual(initial.panelBottom + 1);
  expect(initial.footerBottom, "currency footer starts inside the viewport").toBeLessThanOrEqual(
    initial.visualViewportBottom + 1,
  );

  const search = dialog.getByPlaceholder("搜索货币、代码或符号...");
  await search.focus();
  await expect.poll(async () => (
    await captureDialogMetrics(dialog, CURRENCY_MANAGER_SELECTORS)
  ).rootViewportHeight).toBe("640px");
  const focusSettledAt = await page.evaluate(() => performance.now());
  await expect.poll(async () => page.evaluate((startedAt) => performance.now() - startedAt, focusSettledAt))
    .toBeGreaterThan(VIEWPORT_SYNC_SETTLE_MS);

  await setVisualViewportVars(page, 360, 180);
  await expect.poll(async () => (
    await captureDialogMetrics(dialog, CURRENCY_MANAGER_SELECTORS)
  ).panelHeight).toBeLessThanOrEqual(328);
  const compact = await captureDialogMetrics(dialog, CURRENCY_MANAGER_SELECTORS);
  expect(compact.panelTop, "currency dialog follows the visual viewport top").toBeGreaterThanOrEqual(180);
  expect(compact.headerTop, "currency header stays inside compact visual viewport").toBeGreaterThanOrEqual(180);
  expect(compact.footerHeight, "currency footer keeps its own row").toBeGreaterThan(24);
  expect(compact.footerBottom, "currency footer stays visible in compact viewport").toBeLessThanOrEqual(
    compact.visualViewportBottom + 1,
  );
  await expectDialogChromeFixedWhileBodyScrolls(dialog, CURRENCY_MANAGER_SELECTORS, "currency manager");

  await search.fill("USD");
  await expect(dialog.getByText("USD", { exact: true })).toBeVisible();
  await search.blur();
  await setVisualViewportVars(page, 640);

  await expect.poll(async () => (
    await captureDialogMetrics(dialog, CURRENCY_MANAGER_SELECTORS)
  ).rootViewportHeight).toBe("640px");
  const restored = await captureDialogMetrics(dialog, CURRENCY_MANAGER_SELECTORS);
  expect(restored.footerBottom, "currency footer remains visible after keyboard close").toBeLessThanOrEqual(
    restored.panelBottom + 1,
  );
  expect(restored.footerBottom, "currency footer remains inside the viewport after keyboard close").toBeLessThanOrEqual(
    restored.visualViewportBottom + 1,
  );
});

test("compact wide currency manager keeps header and footer fixed with only the list scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 796, height: 1448 });
  await gotoSettingsSectionAfterHydration(page, "settings-data-config");

  const trigger = page.getByRole("button", { name: /货币管理/ });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "货币管理" });
  await expect(dialog).toBeVisible();
  const metrics = await captureDialogMetrics(dialog, CURRENCY_MANAGER_SELECTORS);
  expect(metrics.footerBottom, "wide compact currency footer stays inside the panel").toBeLessThanOrEqual(
    metrics.panelBottom + 1,
  );
  expect(metrics.scrollHeight, "wide compact currency list owns overflow").toBeGreaterThan(metrics.scrollClientHeight);

  await expectDialogChromeFixedWhileBodyScrolls(dialog, CURRENCY_MANAGER_SELECTORS, "wide compact currency manager");
});

test("mobile subscription create and edit dialogs keep footer inside the visual viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto("/subscriptions");

  const createDialog = await openAddSubscriptionDialog(page);
  await expectSubscriptionDialogAdaptsToKeyboardViewport(page, createDialog, "create subscription");
  await createDialog.getByRole("button", { name: "取消" }).click();
  await expect(createDialog).toBeHidden();

  const subscriptionName = uniqueE2EName(testInfo, "Viewport Edit");
  await createSubscription(page, {
    name: subscriptionName,
    price: "19.99",
  });

  const editDialog = await openSubscriptionEditDialog(page, subscriptionName);
  await expectSubscriptionDialogAdaptsToKeyboardViewport(page, editDialog, "edit subscription");
});
