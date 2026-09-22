import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from "@renewlet/shared/runtime";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { getNextRepeatScheduleOccurrence, getRepeatScheduleDecision, toRfc3339Seconds } from "./notification-schedule";
import {
  parseStringArray,
  settingsFromRowJson,
  SUBSCRIPTION_COLUMN_NAMES,
  SUBSCRIPTION_COLUMNS,
  subscriptionRowValues,
  toApiSubscription,
} from "./db";
import { NOTIFICATION_CRON_WINDOW_MINUTES } from "./notification-jobs";
import {
  subscriptionSchedulerAggregateStatement,
  subscriptionSchedulerDeltaStatement,
  subscriptionSchedulerMutationStatement,
} from "./subscription-scheduler-state";
import type { Env, SubscriptionRow, SubscriptionUserStatsRow } from "./types";

// 本模块把 subscriptions 事实写与四类可重建派生写编排成一个 D1 batch；调用方不能拆批或跳过 guard。
// 单条路径按 tag 数线性，导入路径用 JSON1 压成固定语句数，避免 200 条 apply 放大 Worker/D1 操作数。

export type SubscriptionStatusCounts = Record<SubscriptionStatus, number>;

export interface SubscriptionStats {
  total: number;
  byStatus: SubscriptionStatusCounts;
}

/** 固定状态枚举必须显式补齐零值；未知 D1 脏值沿用既有语义，不进入任何正式状态桶。 */
export function countSubscriptionStatuses(
  rows: readonly Pick<SubscriptionRow, "status">[],
): SubscriptionStatusCounts {
  const counts = emptySubscriptionStatusCounts();
  for (const row of rows) adjustStatusCount(counts, row.status, 1);
  return counts;
}

export type SubscriptionDerivedMutationKind = "create" | "update" | "delete";

export interface SubscriptionDerivedMutation {
  before: SubscriptionRow | null;
  after: SubscriptionRow | null;
  kind: SubscriptionDerivedMutationKind;
}

export interface SubscriptionDerivedWritePlan {
  beforeFact: D1PreparedStatement[];
  afterFact: D1PreparedStatement[];
}

export interface SubscriptionDerivedBulkWritePlan extends SubscriptionDerivedWritePlan {
  fact: D1PreparedStatement;
}

/** 在线写入与离线 v3 修复共享此列序；任何顺序变化都必须同步 SQL placeholder 和校验器。 */
export const SUBSCRIPTION_LIST_INDEX_COLUMNS = [
  "subscription_id", "user_id", "name", "website", "notes", "search_text_lower", "category", "billing_cycle",
  "currency", "payment_method", "status", "pinned", "public_hidden", "next_billing_date", "trial_end_date",
  "one_time_term_count", "auto_renew", "reminder_days", "repeat_reminder_enabled", "created_at", "updated_at",
] as const;

/** 业务键 UPSERT 允许 migration/backfill 在响应丢失后重放，参数顺序由 SUBSCRIPTION_LIST_INDEX_COLUMNS 锁定。 */
export const SUBSCRIPTION_LIST_INDEX_UPSERT_SQL = `
  INSERT INTO subscription_list_index (
    subscription_id, user_id, name, website, notes, search_text_lower, category, billing_cycle, currency,
    payment_method, status, pinned, public_hidden, next_billing_date, trial_end_date, one_time_term_count,
    auto_renew, reminder_days, repeat_reminder_enabled, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(subscription_id) DO UPDATE SET
    user_id = excluded.user_id,
    name = excluded.name,
    website = excluded.website,
    notes = excluded.notes,
    search_text_lower = excluded.search_text_lower,
    category = excluded.category,
    billing_cycle = excluded.billing_cycle,
    currency = excluded.currency,
    payment_method = excluded.payment_method,
    status = excluded.status,
    pinned = excluded.pinned,
    public_hidden = excluded.public_hidden,
    next_billing_date = excluded.next_billing_date,
    trial_end_date = excluded.trial_end_date,
    one_time_term_count = excluded.one_time_term_count,
    auto_renew = excluded.auto_renew,
    reminder_days = excluded.reminder_days,
    repeat_reminder_enabled = excluded.repeat_reminder_enabled,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at
`;

/** 标签以 owner、订阅和规范化 key 幂等收敛；原始显示值仍跟随当前 facts 重建。 */
export const SUBSCRIPTION_TAG_UPSERT_SQL = `
  INSERT INTO subscription_tags (user_id, subscription_id, tag_norm, tag, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, subscription_id, tag_norm) DO UPDATE SET
    tag = excluded.tag,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at
`;

/**
 * 生成单条订阅的完整写入顺序；调用方必须按 beforeFact -> fact -> afterFact 放入同一个 D1 batch。
 * owner 是事实表不可变边界，跨用户移动必须走 delete/create，不能把两个用户的 delta 塞进一次 update。
 */
export function subscriptionDerivedMutationPlan(
  env: Env,
  mutation: SubscriptionDerivedMutation,
  settings: ApiAppSettings,
  now = new Date(),
): SubscriptionDerivedWritePlan {
  assertSubscriptionDerivedMutation(mutation);
  const row = mutation.after ?? mutation.before;
  if (!row) throw new Error("subscription derived mutation requires a before or after row");
  const statements: D1PreparedStatement[] = [];
  if (mutation.after) {
    const tags = normalizeSubscriptionTags(mutation.after);
    statements.push(projectionUpsertStatement(env, mutation.after, tags));
    statements.push(env.DB.prepare("DELETE FROM subscription_tags WHERE user_id = ? AND subscription_id = ?")
      .bind(row.user_id, row.id));
    statements.push(...tags.map((tag) => env.DB.prepare(SUBSCRIPTION_TAG_UPSERT_SQL).bind(
      row.user_id,
      row.id,
      tag.key,
      tag.value,
      mutation.after?.created_at ?? row.created_at,
      mutation.after?.updated_at ?? row.updated_at,
    )));
  } else {
    statements.push(env.DB.prepare("DELETE FROM subscription_list_index WHERE user_id = ? AND subscription_id = ?")
      .bind(row.user_id, row.id));
    statements.push(env.DB.prepare("DELETE FROM subscription_tags WHERE user_id = ? AND subscription_id = ?")
      .bind(row.user_id, row.id));
  }
  statements.push(repeatScheduleMutationStatement(env, mutation.after, settings, now, row.user_id, row.id));
  statements.push(statsDeltaStatement(env, mutation, now));
  statements.push(subscriptionSchedulerMutationStatement(env, mutation, settings, now));
  return {
    beforeFact: [
      mutation.kind === "create"
        ? subscriptionDerivedRowsGuardStatement(env, row.user_id)
        : subscriptionFactSnapshotGuardStatement(env, mutation.before ?? row),
    ],
    afterFact: statements,
  };
}

/** 导入将至多 200 条 mutation 压成固定 SQL 数；事实、投影、tag、schedule 与 aggregate 仍在一个 D1 batch。 */
export function subscriptionDerivedBulkMutationPlan(
  env: Env,
  mutations: SubscriptionDerivedMutation[],
  settings: ApiAppSettings,
  now = new Date(),
): SubscriptionDerivedBulkWritePlan {
  if (mutations.length === 0) throw new Error("subscription bulk mutation requires at least one row");
  for (const mutation of mutations) {
    assertSubscriptionDerivedMutation(mutation);
    if (mutation.kind === "delete" || !mutation.after) {
      throw new Error("subscription import bulk mutation only accepts create/update rows");
    }
  }
  const rows = mutations.flatMap((mutation) => mutation.after ? [mutation.after] : []);
  const firstRow = rows.at(0);
  if (!firstRow || rows.length !== mutations.length) {
    throw new Error("subscription import bulk mutation requires complete after rows");
  }
  const userId = firstRow.user_id;
  if (rows.some((row) => row.user_id !== userId)) throw new Error("subscription bulk mutation requires one owner");

  // JSON 数组只在 D1 batch 内展开成表；事实、投影、tag 和 schedule 仍共享同一事务提交点。
  const identities = rows.map((row) => [row.user_id, row.id]);
  const projectionRows = rows.map((row) => subscriptionListProjectionValues(row, normalizeSubscriptionTags(row)));
  const tagRows = rows.flatMap((row) => normalizeSubscriptionTags(row).map((tag) => [
    row.user_id, row.id, tag.key, tag.value, row.created_at, row.updated_at,
  ]));
  const repeatRows = rows.flatMap((row) => {
    const nextDue = nextRepeatDueForRow(row, settings, now);
    return nextDue ? [[row.user_id, row.id, nextDue]] : [];
  });
  const statusDeltas = emptySubscriptionStats().byStatus;
  let totalDelta = 0;
  let autoDelta = 0;
  let repeatDelta = 0;
  for (const mutation of mutations) {
    totalDelta += Number(Boolean(mutation.after)) - Number(Boolean(mutation.before));
    if (mutation.before) adjustStatusCount(statusDeltas, mutation.before.status, -1);
    if (mutation.after) adjustStatusCount(statusDeltas, mutation.after.status, 1);
    autoDelta += Number(mutation.after?.auto_renew === 1) - Number(mutation.before?.auto_renew === 1);
    repeatDelta += Number(mutation.after?.repeat_reminder_enabled === 1) - Number(mutation.before?.repeat_reminder_enabled === 1);
  }

  return {
    beforeFact: [subscriptionBulkFactSnapshotGuardStatement(env, mutations)],
    fact: subscriptionBulkFactUpsertStatement(env, rows),
    afterFact: [
      subscriptionBulkProjectionUpsertStatement(env, projectionRows),
      subscriptionBulkIdentityDeleteStatement(env, "subscription_tags", identities),
      subscriptionBulkTagInsertStatement(env, tagRows),
      subscriptionBulkIdentityDeleteStatement(env, "subscription_repeat_schedule", identities),
      subscriptionBulkRepeatInsertStatement(env, repeatRows),
      subscriptionStatsDeltaValuesStatement(env, userId, totalDelta, statusDeltas, now),
      subscriptionSchedulerDeltaStatement(env, userId, autoDelta, repeatDelta, settings, now),
    ],
  };
}

function assertSubscriptionDerivedMutation(mutation: SubscriptionDerivedMutation): void {
  const validShape = mutation.kind === "create"
    ? mutation.before === null && mutation.after !== null
    : mutation.kind === "update"
      ? mutation.before !== null && mutation.after !== null
      : mutation.before !== null && mutation.after === null;
  if (!validShape) throw new Error(`invalid subscription ${mutation.kind} derived mutation`);
  if (mutation.before && mutation.after && (
    mutation.before.user_id !== mutation.after.user_id
    || mutation.before.id !== mutation.after.id
  )) {
    throw new Error("subscription identity is immutable");
  }
}

function subscriptionFactSnapshotGuardStatement(env: Env, row: SubscriptionRow): D1PreparedStatement {
  const snapshotPredicates = SUBSCRIPTION_COLUMN_NAMES.map((column) => `subscriptions.${column} IS ?`).join(" AND ");
  // D1 没有交互式事务；完整快照 guard 让并发 update/delete 只能有一个消费 before delta，避免统计和事实行漂移。
  return env.DB.prepare(`
    SELECT CASE
      WHEN EXISTS (
        SELECT 1 FROM subscriptions
        WHERE user_id = ? AND id = ? AND ${snapshotPredicates}
      ) AND EXISTS (
        SELECT 1 FROM subscription_user_stats WHERE user_id = ?
      ) AND EXISTS (
        SELECT 1 FROM subscription_scheduler_state WHERE user_id = ?
      ) THEN 1
      ELSE json('SUBSCRIPTION_WRITE_CONFLICT')
    END AS subscription_write_guard
  `).bind(row.user_id, row.id, ...subscriptionRowValues(row), row.user_id, row.user_id);
}

function subscriptionDerivedRowsGuardStatement(env: Env, userId: string): D1PreparedStatement {
  // Worker 为每个用户预建两条固定 aggregate；缺行属于迁移/数据损坏，热路径只能失败回滚，不能用单条 delta 猜全量。
  return env.DB.prepare(`
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM subscription_user_stats WHERE user_id = ?)
       AND EXISTS (SELECT 1 FROM subscription_scheduler_state WHERE user_id = ?)
      THEN 1
      ELSE json('SUBSCRIPTION_DERIVED_STATE_MISSING')
    END AS subscription_derived_guard
  `).bind(userId, userId);
}

function subscriptionBulkFactSnapshotGuardStatement(
  env: Env,
  mutations: SubscriptionDerivedMutation[],
): D1PreparedStatement {
  const expected = mutations.map((mutation) => [
    mutation.kind,
    subscriptionRowValues(requiredMutationRow(mutation)),
  ]);
  const userId = (mutations[0]?.after ?? mutations[0]?.before)?.user_id ?? "";
  const snapshotMatches = SUBSCRIPTION_COLUMN_NAMES.map((column, index) => (
    `subscriptions.${column} IS json_extract(expected.mutation, '$[1][${index}]')`
  )).join(" AND ");
  return env.DB.prepare(`
    WITH expected AS (SELECT value AS mutation FROM json_each(?))
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM subscription_user_stats WHERE user_id = ?)
       AND EXISTS (SELECT 1 FROM subscription_scheduler_state WHERE user_id = ?)
       AND NOT EXISTS (
        SELECT 1
        FROM expected
        LEFT JOIN subscriptions ON subscriptions.id = json_extract(expected.mutation, '$[1][0]')
        WHERE (
          json_extract(expected.mutation, '$[0]') = 'create'
          AND subscriptions.id IS NOT NULL
        ) OR (
          json_extract(expected.mutation, '$[0]') = 'update'
          AND (
            subscriptions.id IS NULL
            OR NOT (${snapshotMatches})
          )
        )
      ) THEN 1
      ELSE json('SUBSCRIPTION_WRITE_CONFLICT')
    END AS subscription_write_guard
  `).bind(JSON.stringify(expected), userId, userId);
}

function subscriptionBulkFactUpsertStatement(env: Env, rows: SubscriptionRow[]): D1PreparedStatement {
  const selectedColumns = SUBSCRIPTION_COLUMN_NAMES.map((_, index) => `json_extract(value, '$[${index}]')`).join(", ");
  const updateColumns = SUBSCRIPTION_COLUMN_NAMES.filter((column) => !["id", "user_id", "created_at"].includes(column));
  return env.DB.prepare(`
    INSERT INTO subscriptions (${SUBSCRIPTION_COLUMN_NAMES.join(", ")})
    SELECT ${selectedColumns} FROM json_each(?) WHERE true
    ON CONFLICT(id) DO UPDATE SET
      ${updateColumns.map((column) => `${column} = excluded.${column}`).join(",\n      ")}
  `).bind(JSON.stringify(rows.map(subscriptionRowValues)));
}

function subscriptionBulkProjectionUpsertStatement(env: Env, rows: unknown[][]): D1PreparedStatement {
  const selectedColumns = SUBSCRIPTION_LIST_INDEX_COLUMNS.map((_, index) => `json_extract(value, '$[${index}]')`).join(", ");
  return env.DB.prepare(`
    INSERT INTO subscription_list_index (${SUBSCRIPTION_LIST_INDEX_COLUMNS.join(", ")})
    SELECT ${selectedColumns} FROM json_each(?) WHERE true
    ON CONFLICT(subscription_id) DO UPDATE SET
      ${SUBSCRIPTION_LIST_INDEX_COLUMNS.slice(1).map((column) => `${column} = excluded.${column}`).join(",\n      ")}
  `).bind(JSON.stringify(rows));
}

function subscriptionBulkIdentityDeleteStatement(
  env: Env,
  table: "subscription_tags" | "subscription_repeat_schedule",
  identities: string[][],
): D1PreparedStatement {
  return env.DB.prepare(`
    DELETE FROM ${table}
    WHERE (user_id, subscription_id) IN (
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
    )
  `).bind(JSON.stringify(identities));
}

function subscriptionBulkTagInsertStatement(env: Env, rows: unknown[][]): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO subscription_tags (user_id, subscription_id, tag_norm, tag, created_at, updated_at)
    SELECT
      json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),
      json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]')
    FROM json_each(?)
  `).bind(JSON.stringify(rows));
}

function subscriptionBulkRepeatInsertStatement(env: Env, rows: string[][]): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO subscription_repeat_schedule (user_id, subscription_id, next_due_at_utc)
    SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')
    FROM json_each(?)
  `).bind(JSON.stringify(rows));
}

/** 仅供启动 backfill、离线修复和测试 oracle；产品请求不得调用用户级重建。 */
export async function rebuildSubscriptionDerivedStateForUser(env: Env, userId: string, now = new Date()): Promise<void> {
  if (!userId) return;
  const settingsRow = await env.DB.prepare("SELECT settings_json FROM settings WHERE user_id = ? LIMIT 1")
    .bind(userId).first<{ settings_json: string }>();
  const settings = settingsFromRowJson(settingsRow?.settings_json);
  const rows = await env.DB.prepare(`
    SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
    WHERE user_id = ? ORDER BY created_at DESC, id DESC
  `).bind(userId).all<SubscriptionRow>();
  const timestamp = toRfc3339Seconds(now);
  const stats: SubscriptionStats = {
    total: rows.results.length,
    byStatus: countSubscriptionStatuses(rows.results),
  };
  let autoRenewCount = 0;
  let repeatReminderCount = 0;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM subscription_list_index WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM subscription_tags WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM subscription_repeat_schedule WHERE user_id = ?").bind(userId),
  ];
  for (const row of rows.results) {
    if (row.auto_renew === 1) autoRenewCount += 1;
    if (row.repeat_reminder_enabled === 1) repeatReminderCount += 1;
    const tags = normalizeSubscriptionTags(row);
    statements.push(projectionUpsertStatement(env, row, tags));
    statements.push(...tags.map((tag) => env.DB.prepare(SUBSCRIPTION_TAG_UPSERT_SQL).bind(
      row.user_id, row.id, tag.key, tag.value, row.created_at, row.updated_at,
    )));
    const nextDue = nextRepeatDueForRow(row, settings, now);
    if (nextDue) {
      statements.push(env.DB.prepare(`
        INSERT INTO subscription_repeat_schedule (user_id, subscription_id, next_due_at_utc)
        VALUES (?, ?, ?)
      `).bind(row.user_id, row.id, nextDue));
    }
  }
  statements.push(env.DB.prepare(`
    INSERT INTO subscription_user_stats (
      user_id, total_count, trial_count, active_count, expired_count, paused_count, cancelled_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      total_count = excluded.total_count,
      trial_count = excluded.trial_count,
      active_count = excluded.active_count,
      expired_count = excluded.expired_count,
      paused_count = excluded.paused_count,
      cancelled_count = excluded.cancelled_count,
      updated_at = excluded.updated_at
  `).bind(
    userId,
    stats.total,
    stats.byStatus.trial,
    stats.byStatus.active,
    stats.byStatus.expired,
    stats.byStatus.paused,
    stats.byStatus.cancelled,
    timestamp,
    timestamp,
  ));
  statements.push(subscriptionSchedulerAggregateStatement(env, {
    userId,
    autoRenewCount,
    repeatReminderCount,
    lastAutoRenewLocalDate: "",
    settings,
    now,
    skipCurrentNotificationWindow: false,
  }));
  await env.DB.batch(statements);
}

export async function getSubscriptionStats(env: Env, userId: string): Promise<SubscriptionStats> {
  const row = await readSubscriptionStatsRow(env, userId);
  return row ? normalizeSubscriptionStats(row) : emptySubscriptionStats();
}

export async function getSubscriptionTotal(env: Env, userId: string): Promise<number> {
  return (await getSubscriptionStats(env, userId)).total;
}

function projectionUpsertStatement(env: Env, row: SubscriptionRow, tags: ReturnType<typeof normalizeSubscriptionTags>): D1PreparedStatement {
  return env.DB.prepare(SUBSCRIPTION_LIST_INDEX_UPSERT_SQL).bind(...subscriptionListProjectionValues(row, tags));
}

/** 将事实行投影为固定 D1 列序；search 文本必须消费同一批已规范化标签，避免筛选与标签表分叉。 */
export function subscriptionListProjectionValues(
  row: Pick<SubscriptionRow,
    "id" | "user_id" | "name" | "website" | "notes" | "category" | "billing_cycle" | "currency"
    | "payment_method" | "status" | "pinned" | "public_hidden" | "next_billing_date" | "trial_end_date"
    | "one_time_term_count" | "auto_renew" | "reminder_days" | "repeat_reminder_enabled" | "created_at" | "updated_at">,
  tags: readonly { value: string }[],
): Array<string | number | null> {
  return [
    row.id,
    row.user_id,
    row.name,
    row.website,
    row.notes,
    searchTextLower(row, tags.map((tag) => tag.value)),
    row.category,
    row.billing_cycle,
    row.currency,
    row.payment_method,
    row.status,
    row.pinned,
    row.public_hidden,
    row.next_billing_date,
    row.trial_end_date,
    row.one_time_term_count,
    row.auto_renew,
    row.reminder_days,
    row.repeat_reminder_enabled,
    row.created_at,
    row.updated_at,
  ];
}

function repeatScheduleMutationStatement(
  env: Env,
  after: SubscriptionRow | null,
  settings: ApiAppSettings,
  now: Date,
  userId: string,
  subscriptionId: string,
): D1PreparedStatement {
  const nextDue = after ? nextRepeatDueForRow(after, settings, now) : null;
  if (!nextDue) {
    return env.DB.prepare("DELETE FROM subscription_repeat_schedule WHERE user_id = ? AND subscription_id = ?")
      .bind(userId, subscriptionId);
  }
  return env.DB.prepare(`
    INSERT INTO subscription_repeat_schedule (user_id, subscription_id, next_due_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, subscription_id) DO UPDATE SET next_due_at_utc = excluded.next_due_at_utc
  `).bind(userId, subscriptionId, nextDue);
}

function statsDeltaStatement(env: Env, mutation: SubscriptionDerivedMutation, now: Date): D1PreparedStatement {
  const before = mutation.before;
  const after = mutation.after;
  const userId = (after ?? before)?.user_id ?? "";
  const totalDelta = Number(Boolean(after)) - Number(Boolean(before));
  const deltas = emptySubscriptionStats().byStatus;
  if (before) adjustStatusCount(deltas, before.status, -1);
  if (after) adjustStatusCount(deltas, after.status, 1);
  return subscriptionStatsDeltaValuesStatement(env, userId, totalDelta, deltas, now);
}

function subscriptionStatsDeltaValuesStatement(
  env: Env,
  userId: string,
  totalDelta: number,
  deltas: SubscriptionStats["byStatus"],
  now: Date,
): D1PreparedStatement {
  const timestamp = toRfc3339Seconds(now);
  return env.DB.prepare(`
    UPDATE subscription_user_stats SET
      total_count = total_count + ?,
      trial_count = trial_count + ?,
      active_count = active_count + ?,
      expired_count = expired_count + ?,
      paused_count = paused_count + ?,
      cancelled_count = cancelled_count + ?,
      updated_at = ?
    WHERE user_id = ?
  `).bind(
    totalDelta,
    deltas.trial,
    deltas.active,
    deltas.expired,
    deltas.paused,
    deltas.cancelled,
    timestamp,
    userId,
  );
}

async function readSubscriptionStatsRow(env: Env, userId: string): Promise<SubscriptionUserStatsRow | null> {
  if (!userId) return null;
  return await env.DB.prepare(`
    SELECT user_id, total_count, trial_count, active_count, expired_count, paused_count, cancelled_count, created_at, updated_at
    FROM subscription_user_stats WHERE user_id = ? LIMIT 1
  `).bind(userId).first<SubscriptionUserStatsRow>();
}

function normalizeSubscriptionStats(row: SubscriptionUserStatsRow): SubscriptionStats {
  return {
    total: numberValue(row.total_count),
    byStatus: {
      trial: numberValue(row.trial_count),
      active: numberValue(row.active_count),
      expired: numberValue(row.expired_count),
      paused: numberValue(row.paused_count),
      cancelled: numberValue(row.cancelled_count),
    },
  };
}

function emptySubscriptionStats(): SubscriptionStats {
  return { total: 0, byStatus: emptySubscriptionStatusCounts() };
}

function emptySubscriptionStatusCounts(): SubscriptionStatusCounts {
  return { trial: 0, active: 0, expired: 0, paused: 0, cancelled: 0 };
}

function requiredMutationRow(mutation: SubscriptionDerivedMutation): SubscriptionRow {
  const row = mutation.before ?? mutation.after;
  if (!row) throw new Error("subscription derived mutation requires a before or after row");
  return row;
}

function adjustStatusCount(counts: SubscriptionStatusCounts, status: string, delta: number): void {
  if (isSubscriptionStatus(status)) counts[status] += delta;
}

function isSubscriptionStatus(value: string): value is SubscriptionStatus {
  return SUBSCRIPTION_STATUSES.some((status) => status === value);
}

function nextRepeatDueForRow(row: SubscriptionRow, settings: ApiAppSettings, now: Date): string | null {
  if (row.repeat_reminder_enabled !== 1) return null;
  const subscription = toApiSubscription(row);
  const current = getRepeatScheduleDecision(now, settings, [subscription], NOTIFICATION_CRON_WINDOW_MINUTES);
  if (current.due) return current.scheduledInstantUtc;
  return getNextRepeatScheduleOccurrence(now, settings, [subscription])?.scheduledInstantUtc ?? null;
}

/** 使用 locale 无关的 Unicode case mapping 与码点顺序，保证在线写入和 Node 回填生成相同 key 与显示值。 */
export function normalizeSubscriptionTags(
  row: Pick<SubscriptionRow, "tags_json">,
): Array<{ key: string; value: string }> {
  const byKey = new Map<string, string>();
  for (const rawTag of parseStringArray(row.tags_json)) {
    const value = rawTag.trim();
    if (value) byKey.set(value.toLowerCase(), value);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => ({ key, value }));
}

function searchTextLower(
  row: Pick<SubscriptionRow, "name" | "website" | "notes">,
  tags: string[],
): string {
  return [row.name, row.website ?? "", row.notes ?? "", ...tags].join("\n").toLowerCase();
}

function numberValue(value: number | string | null): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value) || 0;
  return 0;
}
