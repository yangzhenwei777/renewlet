/**
 * Cloudflare 日历 Feed handler 管理可撤销的公开 ICS bearer URL。
 *
 * D1 token 是公开读取的唯一凭据；ICS 只导出下一次 date-only 全日事件，不复制续订算法或暴露登录态。
 */
import {
  calendarFeedCreateRequestSchema,
  calendarFeedCreatePayloadSchema,
  calendarFeedRotateRequestSchema,
  calendarFeedStatusPayloadSchema,
  subscriptionCalendarFeedListPayloadSchema,
  subscriptionCalendarFeedListQuerySchema,
} from "@renewlet/shared/schemas/calendar-feed";
import { buildRenewalCalendarIcs } from "@renewlet/shared/ics";
import { buildRenewalCalendarEvent, type RenewalCalendarEvent, type RenewalCalendarSubscription } from "@renewlet/shared/calendar-events";
import { requireCustomBillingCycle } from "@renewlet/shared/subscription-renewal";
import { effectiveReminderDays, isDisabledReminderDays, isValidDateOnly, type BillingCycle } from "@renewlet/shared/runtime";
import { customConfigSchema, type ApiCustomConfig } from "@renewlet/shared/schemas/custom-config";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { getCustomConfig, getSettings, getSubscription, listSubscriptions, newId, nowIso } from "./db";
import { randomToken } from "./crypto";
import { requireAuth } from "./auth";
import { HttpError, ok, readJson, requestLocale, successJson } from "./http";
import { accountContentLocale, serverFormat, serverText, type AppLocale } from "./server-i18n";
import { calendarFeedBuiltInCategoryLabelKey, calendarFeedBuiltInPaymentMethodLabelKey } from "./calendar-feed-built-in-labels";
import { requestOrigin } from "./request-origin";
import { dateOnlyInZone } from "./time";
import type { CalendarFeedRow, Env, SubscriptionRow } from "./types";

type CalendarFeedScope = CalendarFeedRow["scope"];
type CalendarCustomCycleUnit = "day" | "week" | "month" | "year";
type CalendarFixedBillingCycle = Exclude<BillingCycle, "custom">;

interface CalendarSubscription extends RenewalCalendarSubscription {
  status: string;
  customDays?: number | undefined;
  customCycleUnit?: string | undefined;
  reminderDays: number;
}

interface CalendarFeedLabelResolver {
  categoryLabel(value: string): string;
  paymentMethodLabel(value: string | undefined): string | undefined;
}

type CalendarFeedBuiltInLabelKeyResolver = (value: string) => Parameters<typeof serverText>[1] | undefined;

interface SubscriptionCalendarFeedListRow {
  id: string;
  user_id: string;
  subscription_id: string | null;
  token: string;
  created_at: string;
  updated_at: string;
  subscription_name: string | null;
  subscription_status: string | null;
  subscription_next_billing_date: string | null;
  total: number;
}

/** 读取全局续费日历 feed 状态；只返回 URL 展示态，不把 token 拆成独立字段。 */
export async function readCalendarFeed(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await ensureCalendarFeedSchema(env, locale);
  const row = await getCalendarFeed(env, auth.user.id, "all", null);
  return calendarFeedSuccessJson(calendarFeedStatusPayloadSchema.parse({ calendarFeed: calendarFeedStatus(row, request) }));
}

/** 创建或复用全局 feed；请求体必须为空对象，token 始终由服务端生成。 */
export async function createCalendarFeed(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await readJson(request, calendarFeedCreateRequestSchema, locale);
  await ensureCalendarFeedSchema(env, locale);
  const existing = await getCalendarFeed(env, auth.user.id, "all", null);
  const row = existing ?? await insertCalendarFeed(env, {
    scope: "all",
    subscriptionId: null,
    userId: auth.user.id,
  });
  return calendarFeedSuccessJson(calendarFeedCreatePayloadSchema.parse({
    calendarFeed: {
      ...calendarFeedStatus(row, request),
      enabled: true,
    },
  }));
}

export async function deleteCalendarFeed(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await ensureCalendarFeedSchema(env, locale);
  const deleted = await env.DB.prepare(`
    DELETE FROM calendar_feeds
    WHERE user_id = ? AND scope = 'all'
    RETURNING id
  `).bind(auth.user.id).first<{ id: string }>();
  if (!deleted) throw new HttpError(404, serverText(locale, "calendarFeed.notFound"), "NOT_FOUND");
  return calendarFeedOk();
}

export async function readSubscriptionCalendarFeed(request: Request, env: Env, subscriptionId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await ensureCalendarFeedSchema(env, locale);
  const subscription = await getSubscription(env, auth.user.id, subscriptionId);
  if (!subscription) throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");
  if (isOneTimeBuyout(toCalendarSubscription(subscription))) throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");
  const row = await getCalendarFeed(env, auth.user.id, "subscription", subscriptionId);
  return calendarFeedSuccessJson(calendarFeedStatusPayloadSchema.parse({ calendarFeed: calendarFeedStatus(row, request) }));
}

/** 创建单订阅 feed 前先确认订阅属于当前用户，避免用 feed URL 探测他人订阅 ID。 */
export async function createSubscriptionCalendarFeed(request: Request, env: Env, subscriptionId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await readJson(request, calendarFeedCreateRequestSchema, locale);
  await ensureCalendarFeedSchema(env, locale);
  const subscription = await getSubscription(env, auth.user.id, subscriptionId);
  if (!subscription) throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");
  if (isOneTimeBuyout(toCalendarSubscription(subscription))) throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");
  const existing = await getCalendarFeed(env, auth.user.id, "subscription", subscriptionId);
  const row = existing ?? await insertCalendarFeed(env, {
    scope: "subscription",
    subscriptionId,
    userId: auth.user.id,
  });
  return calendarFeedSuccessJson(calendarFeedCreatePayloadSchema.parse({
    calendarFeed: {
      ...calendarFeedStatus(row, request),
      enabled: true,
    },
  }));
}

export async function deleteSubscriptionCalendarFeed(request: Request, env: Env, subscriptionId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await ensureCalendarFeedSchema(env, locale);
  const subscription = await getSubscription(env, auth.user.id, subscriptionId);
  if (!subscription) throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");
  const deleted = await env.DB.prepare(`
    DELETE FROM calendar_feeds
    WHERE user_id = ? AND scope = 'subscription' AND subscription_id = ?
    RETURNING id
  `)
    .bind(auth.user.id, subscriptionId)
    .first<{ id: string }>();
  if (!deleted) throw new HttpError(404, serverText(locale, "calendarFeed.notFound"), "NOT_FOUND");
  return calendarFeedOk();
}

export async function listSubscriptionCalendarFeeds(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await ensureCalendarFeedSchema(env, locale);
  const query = parseSubscriptionCalendarFeedListQuery(request);
  // 单订阅 Feed 与订阅窄投影在一条 owner-scoped 查询中分页；禁止在列表映射阶段逐项回读 subscriptions。
  const result = await env.DB.prepare(`
    WITH owned AS (
      SELECT
        feed.id,
        feed.user_id,
        feed.subscription_id,
        feed.token,
        feed.created_at,
        feed.updated_at,
        subscription.name AS subscription_name,
        subscription.status AS subscription_status,
        subscription.next_billing_date AS subscription_next_billing_date
      FROM calendar_feeds AS feed
      JOIN subscriptions AS subscription
        ON subscription.id = feed.subscription_id
        AND subscription.user_id = feed.user_id
      WHERE feed.user_id = ? AND feed.scope = 'subscription'
    ), page AS (
      SELECT * FROM owned
      ORDER BY updated_at DESC, id DESC
      LIMIT ? OFFSET ?
    )
    SELECT
      COALESCE(page.id, '') AS id,
      COALESCE(page.user_id, '') AS user_id,
      page.subscription_id,
      COALESCE(page.token, '') AS token,
      COALESCE(page.created_at, '') AS created_at,
      COALESCE(page.updated_at, '') AS updated_at,
      page.subscription_name,
      page.subscription_status,
      page.subscription_next_billing_date,
      counts.total AS total
    FROM (SELECT COUNT(*) AS total FROM owned) AS counts
    LEFT JOIN page ON 1 = 1
    ORDER BY page.updated_at DESC, page.id DESC
  `).bind(auth.user.id, query.limit, query.offset).all<SubscriptionCalendarFeedListRow>();
  const total = result.results[0]?.total ?? 0;
  const items = result.results.filter((row) => row.id !== "").map((row) => ({
    id: row.id,
    feedUrl: calendarFeedUrl(request, row.token),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    subscription: {
      id: row.subscription_id ?? "",
      name: row.subscription_name ?? "",
      status: row.subscription_status ?? "",
      nextBillingDate: row.subscription_next_billing_date ?? "",
    },
  }));
  return calendarFeedSuccessJson(subscriptionCalendarFeedListPayloadSchema.parse({
    calendarFeeds: {
      items,
      limit: query.limit,
      offset: query.offset,
      total,
      hasMore: query.offset + items.length < total,
    },
  }));
}

export async function rotateCalendarFeed(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await readJson(request, calendarFeedRotateRequestSchema, locale);
  await ensureCalendarFeedSchema(env, locale);
  const existing = await getCalendarFeed(env, auth.user.id, "all", null);
  if (!existing) throw new HttpError(404, serverText(locale, "calendarFeed.notFound"), "NOT_FOUND");
  return await rotateCalendarFeedRow(request, env, existing);
}

export async function rotateSubscriptionCalendarFeed(request: Request, env: Env, subscriptionId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await readJson(request, calendarFeedRotateRequestSchema, locale);
  await ensureCalendarFeedSchema(env, locale);
  const subscription = await getSubscription(env, auth.user.id, subscriptionId);
  if (!subscription || isOneTimeBuyout(toCalendarSubscription(subscription))) {
    throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");
  }
  const existing = await getCalendarFeed(env, auth.user.id, "subscription", subscriptionId);
  if (!existing) throw new HttpError(404, serverText(locale, "calendarFeed.notFound"), "NOT_FOUND");
  return await rotateCalendarFeedRow(request, env, existing);
}

async function rotateCalendarFeedRow(request: Request, env: Env, existing: CalendarFeedRow): Promise<Response> {
  const token = randomToken();
  const updatedAt = nowIso();
  // 单条 UPDATE 同时失效旧 token 并返回新记录；不能先 DELETE 再 INSERT，失败时旧 URL 必须继续有效。
  const rotated = await env.DB.prepare(`
    UPDATE calendar_feeds
    SET token = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
    RETURNING id, user_id, scope, subscription_id, token, created_at, updated_at
  `).bind(token, updatedAt, existing.id, existing.user_id).first<CalendarFeedRow>();
  if (!rotated) throw new HttpError(404, serverText(requestLocale(request), "calendarFeed.notFound"), "NOT_FOUND");
  return calendarFeedSuccessJson(calendarFeedCreatePayloadSchema.parse({
    calendarFeed: { ...calendarFeedStatus(rotated, request), enabled: true },
  }));
}

export async function downloadSubscriptionCalendarIcs(request: Request, env: Env, subscriptionId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const subscription = await getSubscription(env, auth.user.id, subscriptionId);
  if (!subscription) throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");
  const calendarSubscription = toCalendarSubscription(subscription);
  if (isOneTimeBuyout(calendarSubscription)) throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");
  const settings = await getSettings(env, auth.user.id);
  // 一次性 .ics 进入外部日历后脱离当前请求，因此沿用账号内容语言。
  const contentLocale = accountContentLocale(settings.localePreference);
  const labels = await newCalendarFeedLabelResolver(env, auth.user.id, contentLocale);
  // 不写 SOURCE/TTL，避免外部日历把一次性文件误当成可刷新的订阅 feed。
  const ics = buildRenewalCalendarIcs({
    name: serverFormat(contentLocale, "calendarFeed.subscriptionCalendarName", { name: calendarSubscription.name }),
    generatedAt: new Date(),
    events: subscriptionCalendarEvents(calendarSubscription, settings, labels),
  });
  return new Response(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="renewlet-${safeCalendarFeedFilename(calendarSubscription.id)}.ics"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function calendarFeedIcs(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const token = new URL(request.url).searchParams.get("token")?.trim() ?? "";
  if (!token) throw new HttpError(404, serverText(locale, "calendarFeed.notFound"), "NOT_FOUND");
  let row: CalendarFeedRow | null;
  try {
    row = await env.DB.prepare(`
      SELECT id, user_id, scope, subscription_id, token, created_at, updated_at
      FROM calendar_feeds
      WHERE token = ?
      LIMIT 1
    `).bind(token).first<CalendarFeedRow>();
  } catch (error) {
    if (isUnreadableCalendarFeedTable(error)) {
      // 公开 feed 是 bearer URL，不承担迁移动作；漏迁移、旧表和无效 token 一样不给出表结构线索。
      throw new HttpError(404, serverText(locale, "calendarFeed.notFound"), "NOT_FOUND");
    }
    throw error;
  }
  if (!row) {
    // 公开 feed 是 bearer URL；缺失、撤销和猜测 token 都返回同一个 404，避免泄漏有效性。
    throw new HttpError(404, serverText(locale, "calendarFeed.notFound"), "NOT_FOUND");
  }

  const settings = await getSettings(env, row.user_id);
  const feedUrl = calendarFeedUrl(request, row.token);
  const rendered = await renderCalendarFeed(env, request, row, settings, feedUrl);
  return new Response(rendered.ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `inline; filename="${rendered.filename}"`,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

/** 渲染公开 ICS 内容；scope 决定导出全局续费列表还是单个订阅的一次全日事件。 */
async function renderCalendarFeed(
  env: Env,
  request: Request,
  row: CalendarFeedRow,
  settings: ApiAppSettings,
  feedUrl: string,
): Promise<{ filename: string; ics: string }> {
  // 日历客户端的请求语言不稳定且没有账号会话；Feed 内容必须始终由 owner 的账号内容语言决定。
  const contentLocale = accountContentLocale(settings.localePreference);
  const labels = await newCalendarFeedLabelResolver(env, row.user_id, contentLocale);
  if (row.scope === "subscription") {
    const subscriptionId = row.subscription_id ?? "";
    const subscription = subscriptionId ? await getSubscription(env, row.user_id, subscriptionId) : null;
    if (!subscription) throw new HttpError(404, serverText(requestLocale(request), "calendarFeed.notFound"), "NOT_FOUND");
    const calendarSubscription = toCalendarSubscription(subscription);
    return {
      filename: "renewlet-subscription.ics",
      ics: buildRenewalCalendarIcs({
        name: serverFormat(contentLocale, "calendarFeed.subscriptionCalendarName", { name: calendarSubscription.name }),
        sourceUrl: feedUrl,
        generatedAt: new Date(),
        events: subscriptionCalendarEvents(calendarSubscription, settings, labels),
      }),
    };
  }

  const subscriptions = (await listSubscriptions(env, row.user_id)).map(toCalendarSubscription);
  return {
    filename: "renewlet-renewals.ics",
    ics: buildRenewalCalendarIcs({
      name: serverText(contentLocale, "calendarFeed.calendarName"),
      sourceUrl: feedUrl,
      generatedAt: new Date(),
      events: calendarEvents(subscriptions, settings, labels),
    }),
  };
}

async function newCalendarFeedLabelResolver(
  env: Env,
  userId: string,
  locale: AppLocale,
): Promise<CalendarFeedLabelResolver> {
  const empty = calendarFeedLabelResolver(new Map<string, string>(), new Map<string, string>(), locale);
  const result = customConfigSchema.safeParse(await getCustomConfig(env, userId));
  if (!result.success) return empty;
  // 公开 ICS route 没有登录态上下文；用户配置只做优先查找，缺失的内置项回 server i18n，未知自定义 value 保留原文。
  return calendarFeedLabelResolver(
    calendarFeedLabelMap(result.data.categories, locale),
    calendarFeedLabelMap(result.data.paymentMethods, locale),
    locale,
  );
}

function calendarFeedLabelResolver(
  categoryByValue: Map<string, string>,
  paymentMethodByValue: Map<string, string>,
  locale: AppLocale,
): CalendarFeedLabelResolver {
  return {
    categoryLabel: (value) => calendarFeedResolvedLabel(categoryByValue, calendarFeedBuiltInCategoryLabelKey, locale, value),
    paymentMethodLabel: (value) => value ? calendarFeedResolvedLabel(paymentMethodByValue, calendarFeedBuiltInPaymentMethodLabelKey, locale, value) : value,
  };
}

function calendarFeedResolvedLabel(
  customLabels: Map<string, string>,
  builtInLabelKey: CalendarFeedBuiltInLabelKeyResolver,
  locale: AppLocale,
  value: string,
): string {
  const customLabel = customLabels.get(value);
  if (customLabel) return customLabel;
  const key = builtInLabelKey(value);
  return key ? serverText(locale, key) : value;
}

function calendarFeedLabelMap(items: ApiCustomConfig["categories"], locale: AppLocale): Map<string, string> {
  const labels = new Map<string, string>();
  for (const item of items) {
    const label = calendarFeedLocalizedConfigLabel(item.labels, locale);
    if (label) labels.set(item.value, label);
  }
  return labels;
}

function calendarFeedLocalizedConfigLabel(
  labels: ApiCustomConfig["categories"][number]["labels"],
  locale: AppLocale,
): string | undefined {
  if (locale === "en-US") return labels["en-US"] || labels["zh-CN"] || undefined;
  return labels["zh-CN"] || labels["en-US"] || undefined;
}

async function ensureCalendarFeedSchema(env: Env, locale: ReturnType<typeof requestLocale>): Promise<void> {
  try {
    const columns = await calendarFeedColumns(env);
    if (columns.length === 0) {
      await createCalendarFeedTable(env);
    } else if (!columns.includes("scope") || !columns.includes("token")) {
      await recreateCalendarFeedSchema(env);
    }
    await createCalendarFeedIndexes(env);
  } catch {
    throw new HttpError(500, serverText(locale, "calendarFeed.migrationRequired"), "MIGRATION_REQUIRED");
  }
}

async function calendarFeedColumns(env: Env): Promise<string[]> {
  const result = await env.DB.prepare("PRAGMA table_info(calendar_feeds)").all<{ name: string }>();
  return result.results.map((row) => row.name);
}

async function createCalendarFeedTable(env: Env): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS calendar_feeds (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('all', 'subscription')),
      subscription_id TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE CHECK (length(token) = 43),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (scope = 'all' AND subscription_id IS NULL)
        OR (scope = 'subscription' AND subscription_id IS NOT NULL)
      )
    )
  `).run();
}

async function recreateCalendarFeedSchema(env: Env): Promise<void> {
  // hash-only 旧表无法恢复明文订阅 URL；彻底切换时直接丢弃旧 feed，用户可在登录后重新生成。
  await env.DB.prepare("ALTER TABLE calendar_feeds RENAME TO calendar_feeds_legacy").run();
  await createCalendarFeedTable(env);
  await env.DB.prepare("DROP TABLE calendar_feeds_legacy").run();
}

async function createCalendarFeedIndexes(env: Env): Promise<void> {
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_feeds_user_all_unique ON calendar_feeds (user_id) WHERE scope = 'all'").run();
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_feeds_token ON calendar_feeds (token)").run();
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_feeds_user_subscription_unique ON calendar_feeds (user_id, subscription_id) WHERE scope = 'subscription'").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_calendar_feeds_user_scope_updated_id ON calendar_feeds (user_id, scope, updated_at DESC, id DESC)").run();
}

async function insertCalendarFeed(env: Env, input: {
  scope: CalendarFeedScope;
  subscriptionId: string | null;
  userId: string;
}): Promise<CalendarFeedRow> {
  const token = randomToken();
  const timestamp = nowIso();
  const row: CalendarFeedRow = {
    id: newId("cal"),
    user_id: input.userId,
    scope: input.scope,
    subscription_id: input.subscriptionId,
    token,
    created_at: timestamp,
    updated_at: timestamp,
  };
  // ICS 订阅客户端无法携带 Renewlet 登录态；token 是用户可复制/重置的私有订阅地址，不再做一次性隐藏。
  await env.DB.prepare(`
    INSERT INTO calendar_feeds (id, user_id, scope, subscription_id, token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(row.id, row.user_id, row.scope, row.subscription_id, row.token, row.created_at, row.updated_at).run();
  return row;
}

async function getCalendarFeed(
  env: Env,
  userId: string,
  scope: CalendarFeedScope,
  subscriptionId: string | null,
): Promise<CalendarFeedRow | null> {
  if (scope === "all") {
    return await env.DB.prepare(`
      SELECT id, user_id, scope, subscription_id, token, created_at, updated_at
      FROM calendar_feeds
      WHERE user_id = ? AND scope = 'all'
      LIMIT 1
    `).bind(userId).first<CalendarFeedRow>();
  }
  return await env.DB.prepare(`
    SELECT id, user_id, scope, subscription_id, token, created_at, updated_at
    FROM calendar_feeds
    WHERE user_id = ? AND scope = 'subscription' AND subscription_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(userId, subscriptionId).first<CalendarFeedRow>();
}

function isUnreadableCalendarFeedTable(error: unknown): boolean {
  return error instanceof Error && /(no such table:\s*calendar_feeds|no such column:\s*(id|scope|subscription_id|token))/i.test(error.message);
}

function calendarFeedStatus(row: CalendarFeedRow | null, request: Request) {
  return row ? {
    enabled: true,
    createdAt: row.created_at,
    feedUrl: calendarFeedUrl(request, row.token),
    updatedAt: row.updated_at,
  } : { enabled: false };
}

function calendarFeedUrl(request: Request, token: string): string {
  return `${requestOrigin(request)}/calendar/renewals.ics?token=${encodeURIComponent(token)}`;
}

function parseSubscriptionCalendarFeedListQuery(request: Request) {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if ((key !== "limit" && key !== "offset") || params.getAll(key).length !== 1 || !params.get(key)?.trim()) {
      throw new HttpError(400, serverText(requestLocale(request), "common.invalidRequestParameters"), "INVALID_PAYLOAD");
    }
  }
  const result = subscriptionCalendarFeedListQuerySchema.safeParse(Object.fromEntries(params));
  if (!result.success) {
    throw new HttpError(400, serverText(requestLocale(request), "common.invalidRequestParameters"), "INVALID_PAYLOAD", result.error.flatten());
  }
  return result.data;
}

function calendarFeedSuccessJson(value: unknown): Response {
  // 登录态响应含可复制 bearer URL 或改变其有效性，不能让浏览器/代理缓存撤销前的 token。
  return successJson(value, { headers: { "cache-control": "no-store" } });
}

function calendarFeedOk(): Response {
  const response = ok();
  response.headers.set("cache-control", "no-store");
  return response;
}

function calendarEvents(
  subscriptions: CalendarSubscription[],
  settings: ApiAppSettings,
  labels: CalendarFeedLabelResolver,
): RenewalCalendarEvent[] {
  const today = dateOnlyInZone(new Date(), settings.timezone);
  return subscriptions
    .filter((subscription) => (
      !isOneTimeBuyout(subscription)
      && (subscription.status === "active" || subscription.status === "trial")
      && isValidDateOnly(subscription.nextBillingDate)
      && subscription.nextBillingDate >= today
    ))
    .map((subscription) => calendarEvent(subscription, settings, labels));
}

function subscriptionCalendarEvents(
  subscription: CalendarSubscription,
  settings: ApiAppSettings,
  labels: CalendarFeedLabelResolver,
): RenewalCalendarEvent[] {
  if (isOneTimeBuyout(subscription)) return [];
  return isValidDateOnly(subscription.nextBillingDate) ? [calendarEvent(subscription, settings, labels)] : [];
}

function isOneTimeBuyout(subscription: CalendarSubscription): boolean {
  return subscription.billingCycle === "one-time"
    && (subscription.oneTimeTermCount ?? 0) <= 0;
}

function calendarEvent(
  subscription: CalendarSubscription,
  settings: ApiAppSettings,
  labels: CalendarFeedLabelResolver,
): RenewalCalendarEvent {
  const locale = accountContentLocale(settings.localePreference);
  const reminderDays = isDisabledReminderDays(subscription.reminderDays)
    ? undefined
    : effectiveReminderDays(subscription.reminderDays, settings.notificationReminderDays);
  return buildRenewalCalendarEvent({
    subscription,
    labels: {
      amount: formatAmount(subscription.price),
      billingCycle: billingCycleLabel(subscription, locale),
      category: labels.categoryLabel(subscription.category),
      paymentMethod: labels.paymentMethodLabel(subscription.paymentMethod),
    },
    // “不提醒”不隐藏日历事件，只让 ICS 省略 VALARM，外部日历仍能展示账期。
    reminderDays,
    text: {
      amount: ({ amount, currency }) => serverFormat(locale, "calendarFeed.description.amount", { amount, currency }),
      billingCycle: (cycle) => serverFormat(locale, "calendarFeed.description.billingCycle", { cycle }),
      category: (category) => serverFormat(locale, "calendarFeed.description.category", { category }),
      paymentMethod: (paymentMethod) => serverFormat(locale, "calendarFeed.description.paymentMethod", { paymentMethod }),
      notes: (notes) => serverFormat(locale, "calendarFeed.description.notes", { notes }),
    },
  });
}

function billingCycleLabel(subscription: CalendarSubscription, locale: AppLocale): string {
  if (subscription.billingCycle === "custom") {
    const custom = requireCustomBillingCycle(
      subscription.customDays,
      isCustomCycleUnit(subscription.customCycleUnit) ? subscription.customCycleUnit : undefined,
    );
    const unitKey = `calendarFeed.customCycleUnit.${custom.unit}` as const;
    const unitLabel = serverText(locale, unitKey);
    return serverFormat(locale, "calendarFeed.billingCycle.customValue", {
      count: custom.count,
      unit: unitLabel === unitKey ? custom.unit : unitLabel,
    });
  }
  const cycle = subscription.billingCycle;
  if (!isFixedBillingCycle(cycle)) return cycle;
  const key = `calendarFeed.billingCycle.${cycle}` as const;
  const label = serverText(locale, key);
  return label === key ? cycle : label;
}

function isFixedBillingCycle(value: string): value is CalendarFixedBillingCycle {
  return value === "weekly" ||
    value === "monthly" ||
    value === "quarterly" ||
    value === "semi-annual" ||
    value === "annual" ||
    value === "one-time";
}

function isCustomCycleUnit(value: unknown): value is CalendarCustomCycleUnit {
  return value === "day" || value === "week" || value === "month" || value === "year";
}

function toCalendarSubscription(row: SubscriptionRow): CalendarSubscription {
  // ICS 不是订阅 JSON API 出站边界；这里保留坏 date-only 供事件过滤，避免一条历史脏数据打断整个日历。
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    currency: row.currency,
    billingCycle: row.billing_cycle,
    oneTimeTermCount: row.one_time_term_count ?? undefined,
    category: row.category,
    paymentMethod: row.payment_method ?? undefined,
    nextBillingDate: row.next_billing_date,
    website: row.website ?? undefined,
    notes: row.notes ?? undefined,
    status: row.status,
    customDays: row.custom_days ?? undefined,
    customCycleUnit: row.custom_cycle_unit ?? undefined,
    reminderDays: row.reminder_days,
  };
}

function formatAmount(amount: string): string {
  return amount;
}

function safeCalendarFeedFilename(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_-]/g, "");
  return normalized || "subscription";
}
