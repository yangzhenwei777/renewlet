import {
  advanceSubscriptionRenewal as advanceSharedSubscriptionRenewal,
  type RenewalMode,
  type SubscriptionRenewalInput,
  type SubscriptionRenewalResult,
} from "@renewlet/shared/subscription-renewal";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { getSettings, nowIso, SUBSCRIPTION_COLUMNS } from "./db";
import { subscriptionDerivedMutationPlan } from "./subscription-derived-state";
import { getSubscriptionSchedulerState, listAutoRenewDueUsers, markAutoRenewCheckedForLocalDate } from "./subscription-scheduler-state";
import { dateOnlyInZone } from "./time";
import type { Env, SubscriptionRow, SubscriptionSchedulerStateRow } from "./types";
export { dateOnlyInZone } from "./time";

const RENEWAL_MAINTENANCE_PAGE_SIZE = 500;
const RECURRING_BILLING_CYCLE_SQL = "billing_cycle IN ('weekly', 'monthly', 'quarterly', 'semi-annual', 'annual', 'custom')";

/**
 * 将 D1 订阅行推进为 shared 续订结果。
 *
 * Cloudflare 运行面只做 row -> shared input 映射，账单日算法本身不在 Worker 内复制分叉。
 */
export function advanceSubscriptionRenewal(
  row: SubscriptionRow,
  today: string,
  mode: RenewalMode,
): SubscriptionRenewalResult | null {
  return advanceSharedSubscriptionRenewal(subscriptionRenewalInputFromRow(row), today, mode);
}

/** scheduled 顶层先跑全用户自动续订，再进入通知调度，避免过期旧日期进入本轮提醒。 */
export async function renewAutoSubscriptionsForAllUsers(env: Env, now = new Date()): Promise<{ usersProcessed: number; subscriptionsUpdated: number }> {
  let usersProcessed = 0;
  let subscriptionsUpdated = 0;
  // 顶层只消费 scheduler due-index；真正的本地日期幂等仍在单用户入口判断，避免索引脏值造成误续订。
  for (;;) {
    const users = await listAutoRenewDueUsers(env, now, RENEWAL_MAINTENANCE_PAGE_SIZE);
    for (const user of users) {
      subscriptionsUpdated += await renewAutoSubscriptionsForUser(env, user.user_id, now);
      usersProcessed += 1;
    }
    if (users.length < RENEWAL_MAINTENANCE_PAGE_SIZE) break;
  }
  return { usersProcessed, subscriptionsUpdated };
}

/** 单用户入口从 settings 读取时区；通知、手动运行和 Cron 都复用同一 today 计算。 */
export async function renewAutoSubscriptionsForUser(env: Env, userId: string, now = new Date()): Promise<number> {
  const state = await getSubscriptionSchedulerState(env, userId);
  if (state.auto_renew_count <= 0) return 0;
  const settings = await getSettings(env, userId);
  return renewAutoSubscriptionsForUserWithSettings(env, userId, settings, now, state);
}

/** 已持有 settings 的通知路径复用完整配置，保证续订事实行和派生提醒计划在同一口径下提交。 */
export async function renewAutoSubscriptionsForUserWithSettings(
  env: Env,
  userId: string,
  settings: ApiAppSettings,
  now = new Date(),
  cachedState?: SubscriptionSchedulerStateRow,
): Promise<number> {
  if (!userId) return 0;
  const today = dateOnlyInZone(now, settings.timezone);
  const state = cachedState ?? await getSubscriptionSchedulerState(env, userId);
  if (state.auto_renew_count <= 0) return 0;
  if (state.last_auto_renew_local_date === today) {
    return 0;
  }
  let updated = 0;
  for (;;) {
    let pageUpdated = 0;
    const rows = await env.DB.prepare(`
      SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
      WHERE user_id = ? AND auto_renew = 1 AND ${RECURRING_BILLING_CYCLE_SQL}
        AND next_billing_date < ? AND (status = 'active' OR status = 'trial')
      ORDER BY next_billing_date ASC, id ASC
      LIMIT ?
    `).bind(userId, today, RENEWAL_MAINTENANCE_PAGE_SIZE).all<SubscriptionRow>();
    for (const row of rows.results) {
      const result = advanceSubscriptionRenewal(row, today, "auto");
      if (!result) continue;
      await persistRenewalResult(env, userId, row, result, settings, now);
      updated += 1;
      pageUpdated += 1;
    }
    // 本轮更新后继续从头查，保证一次 cron 能追上跨多期过期订阅，同时不会依赖被改写的游标。
    if (pageUpdated === 0 || rows.results.length < RENEWAL_MAINTENANCE_PAGE_SIZE) {
      await markAutoRenewCheckedForLocalDate(env, userId, today);
      return updated;
    }
  }
}

function subscriptionRenewalInputFromRow(row: SubscriptionRow): SubscriptionRenewalInput {
  return {
    billingCycle: row.billing_cycle as SubscriptionRenewalInput["billingCycle"],
    status: row.status as SubscriptionRenewalInput["status"],
    startDate: row.start_date,
    nextBillingDate: row.next_billing_date,
    autoRenew: row.billing_cycle !== "one-time" && row.auto_renew === 1,
    autoCalculateNextBillingDate: row.auto_calculate_next_billing_date === 1,
    customDays: row.custom_days,
    customCycleUnit: row.custom_cycle_unit,
  };
}

async function persistRenewalResult(
  env: Env,
  userId: string,
  row: SubscriptionRow,
  result: SubscriptionRenewalResult,
  settings: Awaited<ReturnType<typeof getSettings>>,
  now: Date,
): Promise<void> {
  const timestamp = nowIso();
  const after: SubscriptionRow = { ...row, next_billing_date: result.nextBillingDate, status: result.status, updated_at: timestamp };
  // 自动续订在通知内容生成前改写 next_billing_date；写入保持 owner 过滤，防止维护任务误碰其它用户行。
  const factStatement = env.DB.prepare(`
    UPDATE subscriptions SET next_billing_date = ?, status = ?, updated_at = ?
    WHERE user_id = ? AND id = ?
    `).bind(result.nextBillingDate, result.status, timestamp, userId, row.id);
  const derived = subscriptionDerivedMutationPlan(env, { before: row, after, kind: "update" }, settings, now);
  await env.DB.batch([...derived.beforeFact, factStatement, ...derived.afterFact]);
}
