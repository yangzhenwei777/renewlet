import { appSettingsSchema } from "@renewlet/shared/schemas/settings";
import { getSettings, nowIso } from "./db";
import { CronBudget, CRON_SUBSCRIPTION_PAGE_SIZE } from "./cron-budget";
import { claimCronAccount, cronCheckpoint, cronClaimGuard, enqueueDueCronAccounts, releaseCronClaim, type CronProgress } from "./cron-progress";
import { runScheduledForUser } from "./notifications";
import { runScheduledCloudBackupForUser } from "./cloud-backup";
import { collectCloudBackupStaging } from "./cloud-backup-staging";
import { planAutoRenewalPage } from "./subscription-renewal";
import { getSubscriptionSchedulerState } from "./subscription-scheduler-state";
import { addDays, dateOnlyInZone, scheduleOccurrence } from "./notification-schedule";
import type { Env } from "./types";

export async function runCronTick(env: Env, now = new Date()): Promise<void> {
  const budget = new CronBudget();
  const progressEnv = { ...env, DB: budget.database(env.DB) };
  // 业务不能花掉释放租约/提交进度的三条SQL（含provider游标）；外发前另行预留完整结果所需语句。
  const businessEnv = { ...env, DB: budget.database(env.DB, 3) };
  let claim: CronProgress | null = null;
  try {
    try {
      await collectCloudBackupStaging(progressEnv, budget, now);
    } catch (error) {
      // 回收故障保留登记等待下一tick；不能阻断账号续订/提醒，也不能把R2错误正文写进日志。
      console.error("cloud_backup_staging_cleanup_failed", { event: "cloud_backup_staging_cleanup_failed", error: { name: error instanceof Error ? error.name : "Error" } });
    }
    await enqueueDueCronAccounts(progressEnv, now);
    claim = await claimCronAccount(progressEnv, now);
    if (!claim) return;
    const settings = appSettingsSchema.parse({
      ...await getSettings(businessEnv, claim.user_id),
      timezone: claim.time_zone,
      notificationTimeLocal: claim.notification_time_local,
    });
    const scheduledAt = new Date(claim.scheduled_at_utc);
    if (claim.phase === "renewal") {
      const today = dateOnlyInZone(scheduledAt, settings.timezone);
      const state = await getSubscriptionSchedulerState(businessEnv, claim.user_id);
      const page = state.auto_renew_count > 0 && state.last_auto_renew_local_date !== today
        ? await planAutoRenewalPage(businessEnv, claim.user_id, settings, scheduledAt, claim.subscription_after_id, CRON_SUBSCRIPTION_PAGE_SIZE)
        : { complete: true, afterId: "", updated: 0, statements: [] };
      const statements = [cronClaimGuard(progressEnv, claim), ...page.statements];
      if (page.complete && state.auto_renew_count > 0) {
        const nextCheck = scheduleOccurrence(addDays(today, 1), "00:00", settings.timezone).scheduledInstantUtc;
        statements.push(progressEnv.DB.prepare(`UPDATE subscription_scheduler_state
          SET last_auto_renew_local_date = ?, next_auto_renew_check_at_utc = ?, updated_at = ? WHERE user_id = ?`)
          .bind(today, nextCheck, nowIso(), claim.user_id));
      }
      // 续订未完成时保留当前阶段；重启只重做未提交的页，不让旧账期进入通知或备份。
      statements.push(cronCheckpoint(progressEnv, claim, page.complete ? "notification" : "renewal", page.afterId));
      await progressEnv.DB.batch(statements);
    } else if (claim.phase === "notification") {
      const result = await runScheduledForUser(businessEnv, claim.user_id, scheduledAt, { settings, leaseNow: now, budget });
      await progressEnv.DB.batch([cronClaimGuard(progressEnv, claim), cronCheckpoint(progressEnv, claim, result.outcome === "settled" ? "webdav" : "notification")]);
    } else {
      const settled = await runScheduledCloudBackupForUser(businessEnv, claim.user_id, claim.phase, scheduledAt, now, settings, budget, progressEnv.DB);
      const next = settled ? (claim.phase === "webdav" ? "s3" : "complete") : claim.phase;
      await progressEnv.DB.batch([cronClaimGuard(progressEnv, claim), cronCheckpoint(progressEnv, claim, next)]);
    }
  } catch (error) {
    // 平台日志只记录固定阶段和错误类型；provider正文、账号配置和密钥不进入Cron诊断。
    console.error("scheduled_phase_failed", { event: "scheduled_phase_failed", phase: claim?.phase ?? "claim", error: { name: error instanceof Error ? error.name : "Error" } });
    if (claim) await releaseCronClaim(progressEnv, claim);
  } finally {
    console.info("cron_resources", { event: "cron_resources", phase: claim?.phase ?? "idle", ...budget.used });
  }
}
