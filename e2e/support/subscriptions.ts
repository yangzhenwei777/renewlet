import { expect, type Locator, type Page, type Response, type Route, type TestInfo } from "@playwright/test";
import { expectLabelControlGap, getRequiredLocatorBoundingBox } from "./layout";

export function uniqueE2EName(testInfo: TestInfo, prefix: string): string {
  // 项目名、worker 和时间戳一起参与命名，避免 desktop/mobile 共享空库时互相命中旧数据。
  const projectName = testInfo.project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `${prefix}-${projectName}-${testInfo.workerIndex}-${Date.now().toString(36)}`;
}

export function subscriptionCard(page: Page, subscriptionName: string): Locator {
  // 编辑后名称可能包含旧名称；用卡片 testid + 精确 heading，避免文本子串误选到旧卡片。
  return page
    .getByTestId("subscription-card")
    .filter({ has: page.getByRole("heading", { name: subscriptionName, exact: true }) })
    .first();
}

export async function openAddSubscriptionDialog(page: Page) {
  await page.getByRole("button", { name: /添加第一个订阅|添加订阅/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "添加新订阅" });
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function openSubscriptionEditDialog(page: Page, subscriptionName: string) {
  const card = subscriptionCard(page, subscriptionName);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "更多操作" }).click();
  const editAction = page
    .getByRole("menuitem", { name: "编辑" })
    .or(page.getByText("编辑", { exact: true }))
    .first();
  const dialog = page.getByRole("dialog", { name: "编辑订阅" });
  await expect(async () => {
    if (await dialog.isVisible().catch(() => false)) return;
    await expect(editAction).toBeVisible({ timeout: 100 });
  }).toPass({ timeout: 10_000 });

  if (!(await dialog.isVisible().catch(() => false))) {
    await editAction.click();
  }
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function openSubscriptionDetailDialog(page: Page, subscriptionName: string) {
  const card = subscriptionCard(page, subscriptionName);
  await expect(card).toBeVisible();
  const trigger = card.getByTestId("subscription-card-primary-action");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: subscriptionName });
  await expect(dialog).toBeVisible();
  return { dialog, trigger };
}

export async function openSubscriptionCalendarDialog(page: Page, subscriptionName: string) {
  await page.getByPlaceholder("搜索订阅、标签或备注...").fill(subscriptionName);
  const card = subscriptionCard(page, subscriptionName);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "添加到日历" }).click();
  const dialog = page.getByRole("dialog", { name: "添加到日历" });
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function deferNextSubscriptionDetailRead(page: Page, subscriptionId: string) {
  const detailPath = `/api/app/subscriptions/${encodeURIComponent(subscriptionId)}`;
  const matchesDetailPath = (url: URL) => url.pathname === detailPath;
  let releaseRequest!: () => void;
  let reportRequest!: (url: string) => void;
  let held = false;
  let released = false;
  const requestReleased = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const requestObserved = new Promise<string>((resolve) => {
    reportRequest = resolve;
  });
  // 卡片 pointer intent 会先于 click 发起 detail GET；按真实 id 精确冻结，不能误伤同层集合端点。
  const holdDetailRequest = async (route: Route) => {
    const request = route.request();
    if (held || request.method() !== "GET") {
      await route.continue();
      return;
    }

    held = true;
    reportRequest(request.url());
    await requestReleased;
    if (!page.isClosed()) await route.continue();
  };
  const release = () => {
    if (released) return;
    released = true;
    releaseRequest();
  };
  const handlePageClose = () => release();
  await page.route(matchesDetailPath, holdDetailRequest);
  page.once("close", handlePageClose);

  return {
    waitForRequest: () => requestObserved,
    release,
    async dispose() {
      release();
      page.off("close", handlePageClose);
      if (!page.isClosed()) await page.unroute(matchesDetailPath, holdDetailRequest);
    },
  };
}

export async function createSubscription(
  page: Page,
  values: {
    name: string;
    price: string;
    currencyLabel?: string;
    tags?: string;
  },
) {
  const dialog = await openAddSubscriptionDialog(page);
  await fillSubscriptionDialog(page, dialog, values);
  await saveSubscriptionDialog(page, dialog, "添加订阅");
  await expect(subscriptionCard(page, values.name)).toBeVisible();
}

export async function fillSubscriptionDialog(
  page: Page,
  dialog: Locator,
  values: {
    name: string;
    price: string;
    currencyLabel?: string;
    tags?: string;
  },
) {
  await expectLabelControlGap(dialog.getByLabel("服务名称", { exact: true }), "subscription name");
  await expectLabelControlGap(dialog.getByLabel("价格", { exact: true }), "subscription price");
  await expectLabelControlGap(dialog.getByLabel("开始日期（可选）", { exact: true }), "subscription start date");
  await expectLabelControlGap(dialog.getByLabel("到期日期", { exact: true }), "subscription next billing date");
  await expectLabelControlGap(dialog.getByLabel("标签", { exact: true }), "subscription tags");
  await dialog.getByLabel("服务名称", { exact: true }).fill(values.name);
  await dialog.getByLabel("价格", { exact: true }).fill(values.price);

  if (values.currencyLabel) {
    await selectCurrency(page, dialog, values.currencyLabel);
  }
  await chooseSubscriptionDate(page, dialog, "开始日期（可选）", /开始日期.*\d{4}年\d{1,2}月\d{1,2}日/);
  await chooseSubscriptionDate(page, dialog, "到期日期", /到期日期.*\d{4}年\d{1,2}月\d{1,2}日/);

  if (values.tags) {
    await dialog.getByLabel("标签", { exact: true }).fill(values.tags);
  }
}

export async function saveSubscriptionDialog(page: Page, dialog: Locator, submitName: string) {
  // 先注册响应等待再点击，防止快速本地 API 在 Playwright 开始等待前已经返回。
  const responsePromise = page.waitForResponse((response) => isSubscriptionWriteResponse(response));
  await dialog.getByRole("button", { name: submitName }).click();
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(dialog).toBeHidden();
}

export async function expectEmptyTagCursorStaysInline(page: Page, dialog: Locator) {
  const tagInput = dialog.getByLabel("标签", { exact: true });
  await expect(page.getByRole("listbox")).toBeVisible();

  // 这里验证的是 chip + autosize input 的布局约束，不是 tag 业务逻辑；
  // 回归表现为光标在仍有空间时换行，肉眼明显但普通可访问性断言捕捉不到。
  const cursorState = await tagInput.evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) {
      throw new Error("Tag control is not an input");
    }

    const container = element.closest<HTMLElement>('[data-slot="subscription-tag-field"]');
    const sizer = element.closest<HTMLElement>('[data-slot="subscription-tag-input-sizer"]');
    if (!container || !sizer) {
      throw new Error("Tag input is missing its chip field or autosize wrapper");
    }

    const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label^="移除标签"]'))
      .map((button) => button.parentElement)
      .filter((chip): chip is HTMLElement => chip instanceof HTMLElement);
    const lastChip = chips.at(-1);
    if (!lastChip) {
      throw new Error("Expected tag chips before checking empty cursor layout");
    }

    const containerRect = container.getBoundingClientRect();
    const chipRect = lastChip.getBoundingClientRect();
    const sizerRect = sizer.getBoundingClientRect();
    const columnGap = Number.parseFloat(window.getComputedStyle(container).columnGap || "0") || 0;
    const requiredInlineSpace = sizerRect.width + columnGap + 4;
    return {
      freeSpaceAfterLastChip: Math.round(containerRect.right - chipRect.right),
      cursorFitsCurrentRow: containerRect.right - chipRect.right >= requiredInlineSpace,
      gapWidth: Math.round(columnGap),
      inputIsBelowLastChip: sizerRect.top - chipRect.top > 12,
      sizerWidth: Math.round(sizerRect.width),
    };
  });

  expect(
    cursorState.inputIsBelowLastChip && cursorState.cursorFitsCurrentRow,
    `empty tag cursor wrapped with ${cursorState.freeSpaceAfterLastChip}px free for ${cursorState.sizerWidth}px cursor plus ${cursorState.gapWidth}px gap`,
  ).toBe(false);
}

export async function expectTagInputPopoverLayout(page: Page, dialog: Locator) {
  const tagInput = dialog.getByLabel("标签", { exact: true });
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();

  const popoverContent = page.getByTestId("subscription-tag-popover");
  await expect(popoverContent).toHaveAttribute("data-side", "top");

  const [inputBox, popoverBox] = await Promise.all([
    getRequiredLocatorBoundingBox(tagInput, "subscription tag input"),
    getRequiredLocatorBoundingBox(popoverContent, "subscription tag popover"),
  ]);
  expect(
    popoverBox.y + popoverBox.height,
    "subscription tag popover should render above the input when there is room",
  ).toBeLessThanOrEqual(inputBox.y);

  // 多 chip 场景同时容易触发两类回归：popover 方向错误，或 autosize input 挤出字段边界。
  const wrapState = await tagInput.evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) {
      throw new Error("Tag control is not an input");
    }

    const container = element.closest<HTMLElement>('[data-slot="subscription-tag-field"]');
    const sizer = element.closest<HTMLElement>('[data-slot="subscription-tag-input-sizer"]');
    if (!container || !sizer) {
      throw new Error("Tag input is missing its chip field or autosize wrapper");
    }

    const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label^="移除标签"]'))
      .map((button) => button.parentElement)
      .filter((chip): chip is HTMLElement => chip instanceof HTMLElement);
    const lastChip = chips.at(-1);
    if (!lastChip) {
      throw new Error("Expected tag chips before checking input wrapping");
    }

    const containerRect = container.getBoundingClientRect();
    const chipRect = lastChip.getBoundingClientRect();
    const sizerRect = sizer.getBoundingClientRect();
    const inputRect = element.getBoundingClientRect();
    return {
      freeSpaceAfterLastChip: Math.round(containerRect.right - chipRect.right),
      inputIsBelowLastChip: sizerRect.top - chipRect.top > 12,
      inputOverflowsField: inputRect.right > containerRect.right,
      sizerWidth: Math.round(sizerRect.width),
    };
  });

  expect(
    !wrapState.inputIsBelowLastChip && wrapState.freeSpaceAfterLastChip < wrapState.sizerWidth,
    `tag input stayed on a cramped row: ${wrapState.freeSpaceAfterLastChip}px free for ${wrapState.sizerWidth}px input`,
  ).toBe(false);
  expect(wrapState.inputOverflowsField, "tag input should stay inside the field edge").toBe(false);
}

export async function expectTagSuggestionListScrollable(page: Page) {
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();

  const scrollRange = await listbox.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(scrollRange.scrollHeight, "tag suggestions should overflow when many tags exist").toBeGreaterThan(
    scrollRange.clientHeight,
  );

  const scrollTopBefore = await listbox.evaluate((element) => element.scrollTop);
  await listbox.hover();
  await page.mouse.wheel(0, 480);
  await expect
    .poll(() => listbox.evaluate((element) => element.scrollTop), {
      message: "tag suggestions list should consume wheel scrolling",
    })
    .toBeGreaterThan(scrollTopBefore);
}

function isSubscriptionWriteResponse(response: Response): boolean {
  return response.url().includes("/api/app/subscriptions") &&
    ["POST", "PATCH"].includes(response.request().method());
}

async function selectCurrency(page: Page, dialog: Locator, label: string) {
  const currencySelect = dialog.getByRole("combobox", { name: "选择货币" });
  if ((await currencySelect.textContent())?.includes(label)) return;
  await currencySelect.click();
  const currencySheet = page.getByTestId("searchable-select-sheet").last();
  await expect(currencySheet).toBeVisible();
  await currencySheet.getByPlaceholder("搜索货币、代码或符号...").fill(label);
  await currencySheet.getByText(label, { exact: false }).first().click();
  // 移动端 SearchableSelect 选择后会保留 Vaul 退出动画；等 sheet 真正卸载后再操作底层表单。
  await expect(currencySheet).toBeHidden();
  await expect(currencySelect).toContainText(label);
}

async function chooseSubscriptionDate(page: Page, dialog: Locator, label: string, selectedName: RegExp) {
  const dateButton = dialog.getByLabel(label, { exact: true });
  await expect(dateButton).toBeVisible();
  await dateButton.click();

  const calendar = page.getByRole("grid").first();
  await expect(calendar).toBeVisible();

  // 日历今天按钮的 accessible name 受 locale 影响；兜底选择第一个可用日期，保持 E2E
  // 只验证日期控件可用，不把浏览器/组件文案差异误判成订阅流程失败。
  const today = calendar.getByRole("button", { name: /Today|今天/ }).first();
  const selectedDayButton =
    (await today.count()) > 0
      ? today
      : calendar.locator("button:not([disabled])").filter({ hasText: /^\d+$/ }).first();

  await selectedDayButton.click();
  await expect(dialog.getByRole("button", { name: selectedName }).first()).toBeVisible();

  const expandedDateButton = dialog.locator('button[aria-expanded="true"]').first();
  if (await expandedDateButton.count()) {
    // 移动端日期选择现在是 modal sheet；触发器在遮罩后面，统一走 Escape 关闭当前浮层。
    await page.keyboard.press("Escape");
  }

  await expect(calendar).toBeHidden();
}
