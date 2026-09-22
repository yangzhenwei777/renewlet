import { expect, type Locator, type Page, type Response, type TestInfo } from "@playwright/test";

const tagSeparatorPattern = /[、，,;；\n]+/g;
const maxSubscriptionTagLength = 40;

export function createTempPrefix(testInfo: TestInfo): string {
  // 线上巡检使用可识别前缀，失败后的清理脚本能精准删除本轮临时订阅而不碰真实用户数据。
  const projectName = testInfo.project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `e2e-prod-${Date.now()}-${projectName}-${testInfo.workerIndex}`;
}

export function createTempTagName(testInfo: TestInfo): string {
  const shortTimestamp = Date.now().toString(36);
  return `e2e-${shortTimestamp}-${testInfo.workerIndex}-tag`;
}

export function subscriptionCard(page: Page, subscriptionName: string): Locator {
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
  await page.getByRole("menuitem", { name: "编辑" }).click();
  const dialog = page.getByRole("dialog", { name: "编辑订阅" });
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function createTemporarySubscription(
  page: Page,
  values: { name: string; price: string; tags?: string },
) {
  const dialog = await openAddSubscriptionDialog(page);
  const expectedTags = values.tags === undefined ? undefined : parseTagsInput(values.tags);
  await fillSubscriptionDialog(dialog, values);
  await chooseStartDate(page, dialog);
  await saveSubscriptionDialog(page, dialog, "添加订阅", ["POST"], expectedTags);
  await expect(subscriptionCard(page, values.name)).toBeVisible();
  if (expectedTags !== undefined) {
    await expectSubscriptionTagsFromApi(page, values.name, expectedTags);
  }
}

export async function editTemporarySubscription(
  page: Page,
  currentName: string,
  nextValues: { name: string; price: string; tags?: string },
) {
  const dialog = await openSubscriptionEditDialog(page, currentName);
  const expectedTags = nextValues.tags === undefined ? undefined : parseTagsInput(nextValues.tags);
  await fillSubscriptionDialog(dialog, nextValues);
  await chooseDifferentStartDate(page, dialog);
  await saveSubscriptionDialog(page, dialog, "保存修改", ["PATCH"], expectedTags);
  await expect(subscriptionCard(page, nextValues.name)).toBeVisible();
  await expect(subscriptionCard(page, currentName)).toBeHidden();
  if (expectedTags !== undefined) {
    await expectSubscriptionTagsFromApi(page, nextValues.name, expectedTags);
  }
}

export async function expectSubscriptionTagsInEditDialog(
  page: Page,
  subscriptionName: string,
  tags: string[],
) {
  await expectSubscriptionTagsFromApi(page, subscriptionName, tags);
  const dialog = await openSubscriptionEditDialog(page, subscriptionName);
  for (const tag of tags) {
    await expect(dialog.getByRole("button", { name: `移除标签 ${tag}` })).toBeVisible();
  }
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();
}

export async function deleteSubscriptionByName(page: Page, subscriptionName: string): Promise<boolean> {
  const card = subscriptionCard(page, subscriptionName);
  if (!(await card.isVisible().catch(() => false))) return false;

  await card.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "删除" }).click();
  const dialog = page.getByRole("alertdialog", { name: "确认删除订阅" });
  await expect(dialog).toBeVisible();

  const responsePromise = page.waitForResponse((response) =>
    isSubscriptionWriteResponse(response, ["DELETE"]),
  );
  await dialog.getByRole("button", { name: "删除" }).click();
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(card).toBeHidden();
  return true;
}

export async function cleanupTemporarySubscriptions(page: Page, prefix: string) {
  if (page.isClosed()) return;
  if (!/^https?:/.test(page.url())) {
    await page.goto("/subscriptions", { waitUntil: "domcontentloaded" });
  }

  // 清理走线上 API 而不是 UI：失败/超时后页面可能已处在半关闭状态，但 e2e-prod 数据不能污染测试账号。
  const result = await page.evaluate<{ deletedNames: string[]; skippedReason?: string }, string>(async (temporaryPrefix) => {
    const csrfToken = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("renewlet_csrf="))
      ?.slice("renewlet_csrf=".length);
    if (!csrfToken) return { deletedNames: [], skippedReason: "missing-csrf" };

    // 产品 API 不再接受浏览器 Bearer；巡检显式使用 cookie+CSRF，覆盖 Worker 的 session/owner 隔离。
    const unsafeHeaders = { "X-Renewlet-CSRF": decodeURIComponent(csrfToken), "content-type": "application/json" };
    const listResponse = await fetch("/api/app/subscriptions", { credentials: "include" });
    if (!listResponse.ok) {
      return { deletedNames: [], skippedReason: `list-${listResponse.status}` };
    }
    const payload = await listResponse.json().catch(() => null) as unknown;
    const data = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)["data"]
      : null;
    const rows = data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)["subscriptions"]
      : null;
    const subscriptions = Array.isArray(rows) ? rows : [];
    const deletedNames: string[] = [];

    for (const row of subscriptions) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      const id = record["id"];
      const name = record["name"];
      if (typeof id !== "string" || typeof name !== "string" || !name.startsWith(temporaryPrefix)) continue;
      const deleteResponse = await fetch(`/api/app/subscriptions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
        headers: unsafeHeaders,
      });
      if (!deleteResponse.ok) {
        return { deletedNames, skippedReason: `delete-${deleteResponse.status}-${name}` };
      }
      deletedNames.push(name);
    }

    return { deletedNames };
  }, prefix);

  if (result.skippedReason) {
    console.warn(`Cloudflare temporary subscription cleanup skipped: ${result.skippedReason}`);
  }
}

export async function revealCalendarEntry(page: Page, subscriptionName: string) {
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const calendarEntry = page.getByRole("button", { name: subscriptionName, exact: true }).first();
    if (await calendarEntry.isVisible().catch(() => false)) {
      await calendarEntry.click();
      const detailDialog = page.getByRole("dialog", { name: subscriptionName });
      await expect(detailDialog).toBeVisible();
      await detailDialog.getByRole("button", { name: "关闭" }).click();
      await expect(detailDialog).toBeHidden();
      return;
    }
    await page.getByRole("button", { name: "下个月" }).click();
  }
  throw new Error(`Calendar entry not found for ${subscriptionName}`);
}

async function fillSubscriptionDialog(
  dialog: Locator,
  values: { name: string; price: string; tags?: string },
) {
  await dialog.getByLabel("服务名称", { exact: true }).fill(values.name);
  await dialog.getByLabel("价格", { exact: true }).fill(values.price);
  if (values.tags !== undefined) {
    await setSubscriptionTags(dialog, parseTagsInput(values.tags));
  }
}

async function saveSubscriptionDialog(
  page: Page,
  dialog: Locator,
  submitName: string,
  methods: string[],
  expectedTags?: string[],
) {
  const responsePromise = page.waitForResponse((response) =>
    isSubscriptionWriteResponse(response, methods),
  );
  await dialog.getByRole("button", { name: submitName }).click();
  const response = await responsePromise;
  const body = await response.text();
  expect(response.ok(), body).toBe(true);
  if (expectedTags !== undefined) {
    expect(extractSubscriptionTagsFromPayload(body), `${submitName}: write response tags`).toEqual(expectedTags);
  }
  await expect(dialog).toBeHidden();
}

async function setSubscriptionTags(dialog: Locator, tags: string[]) {
  const input = dialog.getByLabel("标签", { exact: true });
  const removeButtons = dialog.getByRole("button", { name: /^移除标签 / });
  while (await removeButtons.count() > 0) {
    await removeButtons.first().click();
  }

  // 标签输入是 combobox + chip 复合控件；E2E 必须确认文本已经变成 chip，再继续提交表单。
  for (const tag of tags) {
    expect(
      Array.from(tag).length,
      `Cloudflare 巡检标签不能超过 ${maxSubscriptionTagLength} 个字符: ${tag}`,
    ).toBeLessThanOrEqual(maxSubscriptionTagLength);
    await input.fill(tag);
    await input.press("Enter");
    await expect(dialog.getByRole("button", { name: `移除标签 ${tag}` })).toBeVisible();
  }
}

function parseTagsInput(value: string): string[] {
  return normalizeTags(value.split(tagSeparatorPattern));
}

function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of tags) {
    const tag = item.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
  }
  return normalized;
}

function extractSubscriptionTagsFromPayload(body: string): string[] {
  const payload = JSON.parse(body) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const subscription = (payload as Record<string, unknown>)["subscription"];
  if (!subscription || typeof subscription !== "object" || Array.isArray(subscription)) return [];
  return getStringArray((subscription as Record<string, unknown>)["tags"]);
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function expectSubscriptionTagsFromApi(page: Page, subscriptionName: string, expectedTags: string[]) {
  const result = await page.evaluate<{ tags?: string[]; error?: string }, string>(async (name) => {
    const response = await fetch("/api/app/subscriptions", {
      credentials: "include",
    });
    if (!response.ok) return { error: `list-${response.status}` };

    const payload = await response.json().catch(() => null) as unknown;
    const data = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)["data"]
      : null;
    const rows = data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)["subscriptions"]
      : null;
    const subscriptions = Array.isArray(rows) ? rows : [];
    const target = subscriptions.find((row) =>
      row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      (row as Record<string, unknown>)["name"] === name,
    );
    if (!target || typeof target !== "object" || Array.isArray(target)) return { error: "not-found" };
    const tags = (target as Record<string, unknown>)["tags"];
    return { tags: Array.isArray(tags) ? tags.filter((item): item is string => typeof item === "string") : [] };
  }, subscriptionName);

  expect(result.error, `${subscriptionName}: API tag read failed`).toBeUndefined();
  expect(result.tags, `${subscriptionName}: API tags`).toEqual(expectedTags);
}

function isSubscriptionWriteResponse(response: Response, methods: string[]): boolean {
  const url = new URL(response.url());
  const method = response.request().method();
  if (!methods.includes(method)) return false;
  if (method === "POST") return url.pathname === "/api/app/subscriptions";
  return url.pathname.startsWith("/api/app/subscriptions/");
}

async function chooseStartDate(page: Page, dialog: Locator) {
  const startDateButton = dialog.getByRole("button", { name: /开始日期/ }).first();
  await startDateButton.click();
  const calendar = page.getByRole("grid").first();
  await expect(calendar).toBeVisible();
  await calendar.locator("button:not([disabled])").filter({ hasText: /^\d+$/ }).first().click();
  await expect(calendar).toBeHidden();
}

async function chooseDifferentStartDate(page: Page, dialog: Locator) {
  const startDateButton = dialog.getByRole("button", { name: /开始日期/ }).first();
  await startDateButton.click();
  const calendar = page.getByRole("grid").first();
  await expect(calendar).toBeVisible();
  const dateButtons = calendar.locator("button:not([disabled])").filter({ hasText: /^\d+$/ });
  const target = (await dateButtons.count()) > 1 ? dateButtons.nth(1) : dateButtons.first();
  await target.click();
  await expect(calendar).toBeHidden();
}
