import { z } from "zod";
import {
  apiTokenCreateRequestSchema,
  apiTokenCreatePayloadSchema,
  apiTokenSchema,
  apiTokensListPayloadSchema,
  publicApiDueQuerySchema,
  publicApiDueItemSchema,
  publicApiDuePayloadSchema,
  publicApiMePayloadSchema,
  publicApiStatusPayloadSchema,
  publicApiSubscriptionPayloadSchema,
  publicApiSubscriptionsListPayloadSchema,
  publicApiSubscriptionsQuerySchema,
  publicApiTokenPlainSchema,
  type ApiToken,
} from "@renewlet/shared/schemas/public-api";
import { requireAuth } from "./auth";
import { randomToken, sha256 } from "./crypto";
import {
  API_TOKEN_COLUMNS_FROM_API_TOKENS,
  SUBSCRIPTION_COLUMNS,
  getSettings,
  getSubscription,
  listApiTokenRows,
  listSubscriptionsPage,
  newId,
  nowIso,
  parsePublicSubscriptionCursor,
  publicSubscriptionCursor,
  toPublicApiSubscription,
} from "./db";
import { getSubscriptionStats, getSubscriptionTotal } from "./subscription-derived-state";
import { dateOnlyInZone } from "./subscription-renewal";
import { bearerToken, HttpError, readJson, requestLocale, successJson } from "./http";
import { serverText } from "./server-i18n";
import type { ApiAppSettings, ApiTokenRow, Env, SubscriptionRow } from "./types";

const PUBLIC_API_TOKEN_PREFIX = "rlt_";
const PUBLIC_API_TOKEN_PREFIX_LENGTH = 12;
const PUBLIC_API_DUE_DEFAULT_DAYS = 30;
// 与 Docker/Go 的 Public API 审计写入窗口保持一致；只降低 D1 write 放大，不改变 bearer 鉴权结果。
const PUBLIC_API_LAST_USED_TOUCH_INTERVAL_MS = 15 * 60 * 1000;

interface PublicApiAuth {
  userId: string;
  scopes: ["read"];
}

interface ApiTokenAuthRow extends ApiTokenRow {
  banned: number;
}

interface PublicApiSubscriptionsOptions {
  limit: number;
  cursor?: string;
  locale: ReturnType<typeof requestLocale>;
}

interface PublicApiDueOptions {
  settings?: ApiAppSettings;
}

export async function listApiTokens(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const tokens = (await listApiTokenRows(env, auth.user.id)).map(toApiToken);
  return noStoreSuccessJson(apiTokensListPayloadSchema.parse({ tokens }));
}

export async function createApiToken(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, apiTokenCreateRequestSchema, locale);
  const timestamp = nowIso();
  const plainToken = publicApiTokenPlainSchema.parse(`${PUBLIC_API_TOKEN_PREFIX}${randomToken(32)}`);
  const tokenHash = await sha256(plainToken);
  const row: ApiTokenRow = {
    id: newId("tok"),
    user_id: auth.user.id,
    name: body.name,
    token_hash: tokenHash,
    token_prefix: plainToken.slice(0, PUBLIC_API_TOKEN_PREFIX_LENGTH),
    scopes_json: JSON.stringify(["read"]),
    last_used_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  // 明文 token 只返回本次响应；D1 写入前就收敛成 hash/prefix，后续列表无法复原明文。
  await env.DB.prepare(`
    INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, scopes_json, last_used_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).bind(row.id, row.user_id, row.name, row.token_hash, row.token_prefix, row.scopes_json, row.created_at, row.updated_at).run();
  return noStoreSuccessJson(apiTokenCreatePayloadSchema.parse({ token: toApiToken(row), plainToken }), { status: 201 });
}

export async function deleteApiToken(request: Request, env: Env, tokenId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  // 删除 token 是鉴权安全边界；D1 不保留墓碑行，旧 bearer 因 hash 行不存在立即 401。
  const result = await env.DB.prepare(`
    DELETE FROM api_tokens
    WHERE user_id = ? AND id = ?
  `).bind(auth.user.id, tokenId).run();
  if ((result.meta.changes ?? 0) === 0) throw new HttpError(404, serverText(locale, "common.notFound"), "NOT_FOUND");
  return noStoreSuccessJson({}, { status: 200 });
}

export async function publicApiMe(request: Request, env: Env): Promise<Response> {
  const auth = await requirePublicApiRead(request, env);
  return noStoreSuccessJson(publicApiMePayloadSchema.parse({ scopes: auth.scopes }));
}

export async function publicApiSubscriptions(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requirePublicApiRead(request, env);
  const url = new URL(request.url);
  const parsed = parseQuery(publicApiSubscriptionsQuerySchema, {
    limit: url.searchParams.get("limit") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
  }, locale);
  return noStoreSuccessJson(await readPublicApiSubscriptionsForUser(env, auth.userId, {
    limit: parsed.limit,
    ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
    locale,
  }));
}

export async function publicApiSubscription(request: Request, env: Env, subscriptionId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requirePublicApiRead(request, env);
  const row = await getSubscription(env, auth.userId, subscriptionId);
  if (!row) throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");
  return noStoreSuccessJson(publicApiSubscriptionPayloadSchema.parse({ subscription: toPublicApiSubscription(row) }));
}

export async function publicApiStatus(request: Request, env: Env): Promise<Response> {
  const auth = await requirePublicApiRead(request, env);
  return noStoreSuccessJson(await readPublicApiStatusForUser(env, auth.userId));
}

export async function publicApiDue(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requirePublicApiRead(request, env);
  const url = new URL(request.url);
  const parsed = parseQuery(publicApiDueQuerySchema, {
    days: url.searchParams.get("days") ?? undefined,
  }, locale);
  return noStoreSuccessJson(await readPublicApiDueForUser(env, auth.userId, parsed.days ?? PUBLIC_API_DUE_DEFAULT_DAYS));
}

export async function readPublicApiSubscriptionsForUser(
  env: Env,
  userId: string,
  options: PublicApiSubscriptionsOptions,
): Promise<z.infer<typeof publicApiSubscriptionsListPayloadSchema>> {
  if (options.cursor && !parsePublicSubscriptionCursor(options.cursor)) {
    throw new HttpError(400, serverText(options.locale, "common.invalidRequestParameters"), "INVALID_CURSOR");
  }
  const rows = await listSubscriptionsPage(env, userId, { limit: options.limit + 1, cursor: options.cursor });
  const pageRows = rows.slice(0, options.limit);
  const lastPageRow = pageRows.at(-1);
  const nextCursor = rows.length > options.limit && lastPageRow ? publicSubscriptionCursor(lastPageRow) : null;
  return publicApiSubscriptionsListPayloadSchema.parse({
    subscriptions: pageRows.map(toPublicApiSubscription),
    nextCursor,
    total: await getSubscriptionTotal(env, userId),
  });
}

export async function readPublicApiStatusForUser(env: Env, userId: string): Promise<z.infer<typeof publicApiStatusPayloadSchema>> {
  const stats = await getSubscriptionStats(env, userId);
  return publicApiStatusPayloadSchema.parse({
    generatedAt: nowIso(),
    total: stats.total,
    byStatus: stats.byStatus,
  });
}

export async function readPublicApiDueForUser(env: Env, userId: string, days: number, options: PublicApiDueOptions = {}): Promise<z.infer<typeof publicApiDuePayloadSchema>> {
  const settings = options.settings ?? await getSettings(env, userId);
  const today = dateOnlyInZone(new Date(), settings.timezone);
  const through = addDateOnlyDays(today, days);
  const result = await env.DB.prepare(`
    SELECT ${SUBSCRIPTION_COLUMNS}
    FROM subscriptions
    WHERE user_id = ?
      AND (
        (next_billing_date >= ? AND next_billing_date <= ?)
        OR (trial_end_date >= ? AND trial_end_date <= ?)
      )
    ORDER BY next_billing_date ASC, trial_end_date ASC, created_at DESC, id DESC
  `).bind(userId, today, through, today, through).all<SubscriptionRow>();
  const items = result.results
    .map((row) => toDueItem(row, today, through))
    .filter((item) => item !== null)
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.subscription.name.localeCompare(right.subscription.name));
  return publicApiDuePayloadSchema.parse({
    days,
    generatedAt: nowIso(),
    items,
  });
}

export async function readPublicApiNextDueForUser(env: Env, userId: string, options: PublicApiDueOptions = {}): Promise<z.infer<typeof publicApiDueItemSchema> | null> {
  const settings = options.settings ?? await getSettings(env, userId);
  const today = dateOnlyInZone(new Date(), settings.timezone);
  // Telegram /next 只需要第一条，但仍复用 Public API due item 契约；先按 owner 和未来日期缩小候选，再用同一 dueType 规则裁掉买断项。
  const result = await env.DB.prepare(`
    SELECT ${SUBSCRIPTION_COLUMNS}
    FROM subscriptions
    WHERE user_id = ?
      AND (
        (status = 'trial' AND trial_end_date IS NOT NULL AND trial_end_date >= ?)
        OR (next_billing_date >= ? AND (billing_cycle != 'one-time' OR one_time_term_count > 0))
      )
    ORDER BY
      CASE
        WHEN status = 'trial'
          AND trial_end_date IS NOT NULL
          AND trial_end_date >= ?
          AND (next_billing_date < ? OR trial_end_date <= next_billing_date)
        THEN trial_end_date
        ELSE next_billing_date
      END ASC,
      created_at DESC,
      id DESC
    LIMIT 10
  `).bind(userId, today, today, today, today).all<SubscriptionRow>();
  const items = result.results
    .map((row) => toDueItem(row, today, "9999-12-31"))
    .filter((item) => item !== null)
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.subscription.name.localeCompare(right.subscription.name));
  return items[0] ?? null;
}

async function requirePublicApiRead(request: Request, env: Env): Promise<PublicApiAuth> {
  const locale = requestLocale(request);
  const token = bearerToken(request);
  const parsedToken = publicApiTokenPlainSchema.safeParse(token);
  if (!parsedToken.success) {
    throw new HttpError(401, serverText(locale, "auth.loginRequired"), "PUBLIC_API_UNAUTHORIZED");
  }
  const tokenHash = await sha256(parsedToken.data);
  const row = await env.DB.prepare(`
    SELECT ${API_TOKEN_COLUMNS_FROM_API_TOKENS}, users.banned AS banned
    FROM api_tokens
    JOIN users ON users.id = api_tokens.user_id
    WHERE api_tokens.token_hash = ?
    LIMIT 1
  `).bind(tokenHash).first<ApiTokenAuthRow>();
  if (!row || row.banned === 1 || !apiTokenHasReadScope(row)) {
    throw new HttpError(401, serverText(locale, "auth.loginRequired"), "PUBLIC_API_UNAUTHORIZED");
  }
  await touchApiTokenLastUsedIfStale(env, row.id, row.last_used_at);
  return { userId: row.user_id, scopes: ["read"] };
}

async function touchApiTokenLastUsedIfStale(env: Env, tokenId: string, lastUsedAt: string | null): Promise<void> {
  const lastUsed = Date.parse(lastUsedAt ?? "");
  const now = Date.now();
  if (!Number.isNaN(lastUsed) && now - lastUsed < PUBLIC_API_LAST_USED_TOUCH_INTERVAL_MS) return;
  const timestamp = new Date(now).toISOString();
  // Public API 与浏览器 session 分离；last_used_at 只做 token 使用审计，不延长或创建登录态。
  await env.DB.prepare("UPDATE api_tokens SET last_used_at = ?, updated_at = ? WHERE id = ?").bind(timestamp, timestamp, tokenId).run();
}

function toApiToken(row: ApiTokenRow): ApiToken {
  return apiTokenSchema.parse({
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: ["read"],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  });
}

function apiTokenHasReadScope(row: Pick<ApiTokenRow, "scopes_json">): boolean {
  try {
    const scopes = JSON.parse(row.scopes_json) as unknown;
    return Array.isArray(scopes) && scopes.includes("read");
  } catch {
    return false;
  }
}

function parseQuery<Schema extends z.ZodType>(schema: Schema, input: unknown, locale: ReturnType<typeof requestLocale>): z.infer<Schema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"), "INVALID_QUERY", result.error.flatten());
  }
  return result.data;
}

function toDueItem(row: SubscriptionRow, today: string, through: string) {
  const dueType = dueTypeForSubscription(row, today, through);
  if (!dueType) return null;
  const subscription = toPublicApiSubscription(row);
  return {
    dueDate: dueType === "trial" ? row.trial_end_date! : row.next_billing_date,
    dueType,
    subscription,
  };
}

function dueTypeForSubscription(row: SubscriptionRow, today: string, through: string): "renewal" | "trial" | "expiry" | null {
  if (row.status === "trial" && row.trial_end_date && row.trial_end_date >= today && row.trial_end_date <= through) return "trial";
  if (row.next_billing_date < today || row.next_billing_date > through) return null;
  if (row.billing_cycle === "one-time") return row.one_time_term_count && row.one_time_term_count > 0 ? "expiry" : null;
  return "renewal";
}

function addDateOnlyDays(value: string, days: number): string {
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number.parseInt(yearText ?? "", 10);
  const month = Number.parseInt(monthText ?? "", 10);
  const day = Number.parseInt(dayText ?? "", 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return value;
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function noStoreSuccessJson(value: unknown, init: ResponseInit = {}): Response {
  const response = successJson(value, init);
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}
