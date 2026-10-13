import type { NotificationEmailMessage } from "@renewlet/shared/email-template";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { CronBudgetExceeded, CRON_EXTERNAL_REQUEST_LIMIT, type CronBudget } from "./cron-budget";
import { sendChannels } from "./notification-channel-send";
import { checkpointNotificationDelivery, notificationDeliveryPending, readNotificationDelivery, type CronJobResult } from "./notification-delivery-storage";
import {
  NOTIFICATION_CRON_WINDOW_MINUTES, NOTIFICATION_MAX_RETRIES, NOTIFICATION_STALE_SENDING_MINUTES,
  channelsToSend, createCronJobResult, createNotificationJob, failExhaustedNotificationJob, finalizeNotificationJob,
  getNotificationJob, isNotificationJobTerminal, isSendingJobFresh, markNotificationJobSending, mergeChannelResults, readJobChannels,
  type Channel, type JobChannels,
} from "./notification-jobs";
import { notificationMessageParts, notificationMessageWriteCount } from "./notification-message-storage";
import { toRfc3339Seconds, type ScheduleOccurrence } from "./notification-schedule";
import { normalizeServerLocale } from "./server-i18n";
import type { AppLocale } from "./http";
import type { Env, NotificationJobRow } from "./types";

export type CronRunOutcome = "settled" | "keep_due";
const emptyChannels = (): JobChannels => ({ attempted: [], succeeded: [], failed: [] });

export async function runCronForUser(
  env: Env,
  userId: string,
  settings: ApiAppSettings,
  schedule: ScheduleOccurrence,
  now: Date,
  locale: AppLocale,
  buildMessage: () => NotificationEmailMessage | Promise<NotificationEmailMessage>,
  budget?: CronBudget,
): Promise<CronRunOutcome> {
  const existing = await getNotificationJob(env, userId, schedule);
  if (isNotificationJobTerminal(existing)) return "settled";
  if (existing && isSendingJobFresh(existing, now, NOTIFICATION_STALE_SENDING_MINUTES)) return "keep_due";
  const pending = notificationDeliveryPending(existing);
  // attempts是整轮次数；第三轮尚未尝试的渠道仍要续接，不能把正常分片当作重试耗尽。
  if (existing && pending) return await continueDelivery(env, existing, pending, settings, budget);
  if (existing && existing.attempts >= NOTIFICATION_MAX_RETRIES) {
    if (existing.status === "sending" && !await failExhaustedNotificationJob(env, existing)) return "keep_due";
    return "settled";
  }

  const message = await buildMessage();
  const previous = readJobChannels(existing);
  const channels = mergeChannelResults(previous, emptyChannels(), settings.enabledChannels);
  const nextChannels = channelsToSend(existing, previous, settings.enabledChannels);
  const reason = settings.enabledChannels.length === 0 ? "no_enabled_channels" : !message.hasPayload ? "no_due_items" : null;
  const result = createCronJobResult({ reason, force: false, windowMinutes: NOTIFICATION_CRON_WINDOW_MINUTES,
    triggeredAtUtc: toRfc3339Seconds(now), schedule, settings, locale, message, channels });
  const parts = notificationMessageParts(message);
  // 发送前预留快照、接管、渠道结果和外层三条进度SQL；已发出的结果不能因本地额度不足丢失。
  budget?.requireSql(notificationMessageWriteCount(parts) + 5);
  if (reason || nextChannels.length === 0) {
    const status = reason ? "skipped" : "sent";
    if (reason) result.channels = emptyChannels();
    return await finalizeNotificationJob(env, existing, userId, schedule, status, Math.max(1, existing?.attempts ?? 1), null, result, parts) ? "settled" : "keep_due";
  }

  // 单渠道独占本片外发额度；极端单渠道链超限计入本轮失败，不得无限续接同一条不可完成的链。
  budget?.requireExternal(CRON_EXTERNAL_REQUEST_LIMIT);
  let claim: NotificationJobRow | null;
  if (existing) claim = await markNotificationJobSending(env, existing, existing.attempts + 1);
  else {
    const created = await createNotificationJob(env, userId, schedule, "sending", 1);
    claim = created.created ? created.row : null;
  }
  if (!claim) return "keep_due";
  if (!await checkpointNotificationDelivery(env, claim, result, nextChannels, parts.length, "sending", parts)) return "keep_due";
  return await deliverChannel(env, claim, result, nextChannels, parts.length, settings, budget);
}

async function continueDelivery(env: Env, existing: NotificationJobRow, pending: Channel[], settings: ApiAppSettings, budget?: CronBudget): Promise<CronRunOutcome> {
  const saved = await readNotificationDelivery(env, existing);
  if (!saved) return "keep_due";
  let channels = mergeChannelResults(saved.result.channels, emptyChannels(), settings.enabledChannels);
  if (existing.status === "sending") {
    const interrupted = pending[0];
    // stale发送可能已到达第三方；不承诺exactly-once。先记录结果未知，推进其它渠道，再由下一轮有界重试。
    if (interrupted) channels = mergeChannelResults(channels, {
      attempted: [interrupted], succeeded: [], failed: settings.enabledChannels.includes(interrupted) ? [{ channel: interrupted, error: "delivery_interrupted" }] : [],
    }, settings.enabledChannels);
    pending = pending.slice(1);
  }
  pending = pending.filter((channel) => settings.enabledChannels.includes(channel) && !channels.succeeded.includes(channel));
  const result = { ...saved.result, channels };
  budget?.requireSql(6);
  if (pending.length) budget?.requireExternal(CRON_EXTERNAL_REQUEST_LIMIT);
  const claim = await markNotificationJobSending(env, existing, existing.attempts);
  if (!claim) return "keep_due";
  if (!pending.length) return await completeChannel(env, claim, result, pending, saved.chunkCount);
  // 重新接管后先持久化当前渠道；崩溃恢复只把它标为未知，尚未尝试的渠道仍属于本轮。
  if (!await checkpointNotificationDelivery(env, claim, result, pending, saved.chunkCount, "sending")) return "keep_due";
  return await deliverChannel(env, claim, result, pending, saved.chunkCount, settings, budget);
}

async function deliverChannel(env: Env, claim: NotificationJobRow, result: CronJobResult, pending: Channel[], chunkCount: number, settings: ApiAppSettings, budget?: CronBudget): Promise<CronRunOutcome> {
  const channel = pending[0];
  if (!channel) throw new Error("Notification delivery channel is missing");
  let summary: JobChannels;
  try {
    summary = await sendChannels(env, [channel], settings, result.message, normalizeServerLocale(result.settings.locale), undefined, budget);
  } catch (error) {
    if (!(error instanceof CronBudgetExceeded) || error.resource !== "external") throw error;
    // 预算错误没有provider原文；保留此前成功渠道，并以稳定错误结束本渠道的这轮尝试。
    summary = { attempted: [channel], succeeded: [], failed: [{ channel, error: error.message }] };
  }
  const channels = mergeChannelResults(result.channels, summary, settings.enabledChannels);
  return await completeChannel(env, claim, { ...result, channels }, pending.slice(1), chunkCount);
}

async function completeChannel(env: Env, claim: NotificationJobRow, result: CronJobResult, pending: Channel[], chunkCount: number): Promise<CronRunOutcome> {
  const status = pending.length ? "pending" : result.channels.failed.length ? "failed" : "sent";
  const next = { ...result, reason: result.channels.failed.length ? "some_channels_failed" : null };
  const persisted = await checkpointNotificationDelivery(env, claim, next, pending, chunkCount, status);
  return persisted && (status === "sent" || (status === "failed" && claim.attempts >= NOTIFICATION_MAX_RETRIES)) ? "settled" : "keep_due";
}
