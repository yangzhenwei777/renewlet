import { CRON_CLAIM_DURATION_MS } from "./cron-budget";
import { toRfc3339Seconds } from "./time";
import type { Env } from "./types";

export type CronPhase = "renewal" | "notification" | "webdav" | "s3";
export interface CronProgress {
  user_id: string;
  phase: CronPhase;
  scheduled_at_utc: string;
  time_zone: string;
  notification_time_local: string;
  subscription_after_id: string;
  claim_token: string;
  claim_until_utc: string;
}

export async function enqueueDueCronAccounts(env: Env, now: Date): Promise<void> {
  const timestamp = toRfc3339Seconds(now);
  // 入队后冻结窗口；后续tick只更新服务顺序/租约，不能用新时间覆盖尚未处理的提醒键。
  await env.DB.prepare(`
    INSERT OR IGNORE INTO cron_progress (user_id, phase, scheduled_at_utc, time_zone, notification_time_local)
    SELECT users.id, 'renewal', COALESCE((
      SELECT MIN(instant) FROM (
        SELECT scheduler.next_daily_notification_due_at_utc AS instant
        UNION ALL SELECT scheduler.next_repeat_notification_due_at_utc WHERE scheduler.repeat_reminder_count > 0
      ) WHERE instant <= ?
    ), ?), COALESCE(json_extract(settings.settings_json, '$.timezone'), 'UTC'),
      COALESCE(json_extract(settings.settings_json, '$.notificationTimeLocal'), '08:00')
    FROM users JOIN subscription_scheduler_state AS scheduler ON scheduler.user_id = users.id
    LEFT JOIN settings ON settings.user_id = users.id
    WHERE users.banned = 0 AND NOT EXISTS (SELECT 1 FROM cron_progress WHERE user_id = users.id)
      AND (
        (scheduler.auto_renew_count > 0 AND (scheduler.next_auto_renew_check_at_utc IS NULL OR scheduler.next_auto_renew_check_at_utc <= ?))
        OR scheduler.next_daily_notification_due_at_utc IS NULL OR scheduler.next_daily_notification_due_at_utc <= ?
        OR (scheduler.repeat_reminder_count > 0 AND (scheduler.next_repeat_notification_due_at_utc IS NULL OR scheduler.next_repeat_notification_due_at_utc <= ?))
        OR EXISTS (SELECT 1 FROM cloud_backup_targets WHERE user_id = users.id AND schedule_enabled = 1 AND (next_run_at_utc IS NULL OR next_run_at_utc <= ?))
      )
    ORDER BY users.id LIMIT 50
  `).bind(timestamp, timestamp, timestamp, timestamp, timestamp, timestamp).run();
}

export async function claimCronAccount(env: Env, now: Date): Promise<CronProgress | null> {
  const timestamp = now.toISOString();
  const until = new Date(now.getTime() + CRON_CLAIM_DURATION_MS).toISOString();
  // 账号按最久未服务轮转；一个大账号的续订页不能长期挡住其它账号。租约只比较真实当前时间。
  return env.DB.prepare(`
    UPDATE cron_progress SET claim_token = ?, claim_until_utc = ?, served_at_utc = ?
    WHERE user_id = (
      SELECT progress.user_id FROM cron_progress AS progress JOIN users ON users.id = progress.user_id
      WHERE users.banned = 0 AND (claim_until_utc IS NULL OR claim_until_utc <= ?)
      ORDER BY served_at_utc, progress.user_id LIMIT 1
    )
    RETURNING user_id, phase, scheduled_at_utc, time_zone, notification_time_local, subscription_after_id, claim_token, claim_until_utc
  `).bind(crypto.randomUUID(), until, timestamp, timestamp).first<CronProgress>();
}

export function cronClaimGuard(env: Env, claim: CronProgress): D1PreparedStatement {
  // 此guard与事实写/游标同batch；租约已被接管时整组回滚，不能只拒绝最后的进度UPDATE。
  return env.DB.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM cron_progress WHERE user_id = ? AND claim_token = ?
    ) THEN 1 ELSE json('CRON_CLAIM_LOST') END AS cron_claim_guard`).bind(claim.user_id, claim.claim_token);
}

export function cronCheckpoint(
  env: Env,
  claim: CronProgress,
  phase: CronPhase | "complete",
  afterId = "",
): D1PreparedStatement {
  if (phase === "complete") {
    return env.DB.prepare("DELETE FROM cron_progress WHERE user_id = ? AND claim_token = ?").bind(claim.user_id, claim.claim_token);
  }
  return env.DB.prepare(`UPDATE cron_progress SET phase = ?, subscription_after_id = ?, claim_token = NULL, claim_until_utc = NULL
    WHERE user_id = ? AND claim_token = ?`).bind(phase, afterId, claim.user_id, claim.claim_token);
}

export async function releaseCronClaim(env: Env, claim: CronProgress): Promise<void> {
  await cronCheckpoint(env, claim, claim.phase, claim.subscription_after_id).run();
}
