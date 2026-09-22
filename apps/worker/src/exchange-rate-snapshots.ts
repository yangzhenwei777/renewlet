import {
  exchangeRateSnapshotBodySchema,
  exchangeRateSnapshotPayloadSchema,
  exchangeRateSnapshotsPayloadSchema,
  exchangeRateSnapshotV1Schema,
  type ExchangeRateSnapshotPublicBasis,
  type ExchangeRateSnapshotV1,
} from "@renewlet/shared/schemas/exchange-rates";
import { requireAuth } from "./auth";
import { nowIso } from "./db";
import { HttpError, readJson, requestLocale, successJson } from "./http";
import { serverText } from "./server-i18n";
import type { Env, ExchangeRateSnapshotRow } from "./types";

const REPORT_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const EXCHANGE_RATE_SNAPSHOT_COLUMNS = [
  "user_id",
  "month",
  "base",
  "rates_json",
  "requested_provider",
  "provider",
  "source_date",
  "captured_at",
  "warning_json",
  "created_at",
  "updated_at",
].join(", ");

export async function readExchangeRateSnapshots(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const url = new URL(request.url);
  const from = url.searchParams.get("from")?.trim() ?? "";
  const to = url.searchParams.get("to")?.trim() ?? "";
  if ((from && !REPORT_MONTH_PATTERN.test(from)) || (to && !REPORT_MONTH_PATTERN.test(to)) || (from && to && from > to)) {
    throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"), "INVALID_REQUEST_PARAMETERS");
  }
  const snapshots = await listExchangeRateSnapshots(env, auth.user.id, { from, to });
  return successJson(exchangeRateSnapshotsPayloadSchema.parse({ snapshots }));
}

export async function putExchangeRateSnapshot(request: Request, env: Env, month: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  if (!REPORT_MONTH_PATTERN.test(month)) {
    throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"), "INVALID_REQUEST_PARAMETERS");
  }
  const currentMonth = currentReportMonth();
  if (month !== currentMonth) {
    // 登录态 capture 不能写已关闭月份；历史月份只能由 ZIP 恢复带入，防止当前汇率污染历史报表。
    throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"), "INVALID_REQUEST_PARAMETERS");
  }
  const body = await readJson(request, exchangeRateSnapshotBodySchema, locale);
  const timestamp = nowIso();
  const snapshot = exchangeRateSnapshotV1Schema.parse({
    schemaVersion: 1,
    month,
    ...body,
    capturedAt: timestamp,
  });
  await upsertExchangeRateSnapshot(env, auth.user.id, snapshot, timestamp);
  return successJson(exchangeRateSnapshotPayloadSchema.parse({ snapshot }));
}

export async function listExchangeRateSnapshots(
  env: Env,
  userId: string,
  options: { from?: string; to?: string } = {},
): Promise<ExchangeRateSnapshotV1[]> {
  const filters = ["user_id = ?"];
  const params: unknown[] = [userId];
  if (options.from) {
    filters.push("month >= ?");
    params.push(options.from);
  }
  if (options.to) {
    filters.push("month <= ?");
    params.push(options.to);
  }
  const result = await env.DB.prepare(`
    SELECT ${EXCHANGE_RATE_SNAPSHOT_COLUMNS}
    FROM exchange_rate_snapshots
    WHERE ${filters.join(" AND ")}
    ORDER BY month ASC
    LIMIT 240
  `).bind(...params).all<ExchangeRateSnapshotRow>();
  return result.results.map(exchangeRateSnapshotFromRow);
}

export function exchangeRateSnapshotUpsertStatement(
  env: Env,
  userId: string,
  snapshot: ExchangeRateSnapshotV1,
  timestamp: string,
): D1PreparedStatement {
  const parsed = exchangeRateSnapshotV1Schema.parse(snapshot);
  // 快照持久层只存 normalized rates/warning JSON；provider raw response 只允许作为当前请求错误详情展示。
  return env.DB.prepare(`
    INSERT INTO exchange_rate_snapshots (
      user_id, month, base, rates_json, requested_provider, provider, source_date, captured_at, warning_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, month) DO UPDATE SET
      base = excluded.base,
      rates_json = excluded.rates_json,
      requested_provider = excluded.requested_provider,
      provider = excluded.provider,
      source_date = excluded.source_date,
      captured_at = excluded.captured_at,
      warning_json = excluded.warning_json,
      updated_at = excluded.updated_at
  `).bind(
    userId,
    parsed.month,
    parsed.base,
    JSON.stringify(parsed.rates),
    parsed.requestedProvider,
    parsed.provider,
    parsed.sourceDate,
    parsed.capturedAt,
    parsed.warning ? JSON.stringify(parsed.warning) : null,
    timestamp,
    timestamp,
  );
}

export async function upsertExchangeRateSnapshot(env: Env, userId: string, snapshot: ExchangeRateSnapshotV1, timestamp = nowIso()): Promise<void> {
  await exchangeRateSnapshotUpsertStatement(env, userId, snapshot, timestamp).run();
}

export async function getExchangeRatePublicBasis(env: Env, userId: string, now = new Date()): Promise<ExchangeRateSnapshotPublicBasis> {
  const month = reportMonthFromDate(now);
  const row = await env.DB.prepare(`
    SELECT ${EXCHANGE_RATE_SNAPSHOT_COLUMNS}
    FROM exchange_rate_snapshots
    WHERE user_id = ? AND month = ?
    LIMIT 1
  `).bind(userId, month).first<ExchangeRateSnapshotRow>();
  if (!row) return { status: "live", month };
  try {
    const snapshot = exchangeRateSnapshotFromRow(row);
    // 公开页只暴露 normalized rates 和非密 metadata；owner、warning 与存储字段不进入匿名响应。
    return {
      status: "locked",
      month: snapshot.month,
      base: snapshot.base,
      rates: snapshot.rates,
      sourceDate: snapshot.sourceDate,
      capturedAt: snapshot.capturedAt,
    };
  } catch {
    return { status: "live", month };
  }
}

function exchangeRateSnapshotFromRow(row: ExchangeRateSnapshotRow): ExchangeRateSnapshotV1 {
  return exchangeRateSnapshotV1Schema.parse({
    schemaVersion: 1,
    month: row.month,
    base: row.base,
    rates: JSON.parse(row.rates_json) as unknown,
    requestedProvider: row.requested_provider,
    provider: row.provider,
    sourceDate: row.source_date,
    capturedAt: row.captured_at,
    ...(row.warning_json ? { warning: JSON.parse(row.warning_json) as unknown } : {}),
  });
}

function currentReportMonth(): string {
  return reportMonthFromDate(new Date());
}

function reportMonthFromDate(date: Date): string {
  return date.toISOString().slice(0, 7);
}
