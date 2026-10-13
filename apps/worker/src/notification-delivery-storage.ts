import { z } from "zod";
import { cronJobResultResponseSchema, notificationChannelSchema } from "@renewlet/shared/schemas/notifications";
import type { Channel, createCronJobResult } from "./notification-jobs";
import { lastErrorFromChannels, normalizeJobChannels } from "./notification-jobs";
import { notificationMessageStatements, restoreNotificationJobMessage } from "./notification-message-storage";
import { normalizeServerLocale } from "./server-i18n";
import type { Env, NotificationJobRow } from "./types";

export type CronJobResult = ReturnType<typeof createCronJobResult>;
const pendingSchema = z.array(notificationChannelSchema).min(1).max(notificationChannelSchema.options.length)
  .refine((channels) => new Set(channels).size === channels.length, "Duplicate delivery channel");
const metadataSchema = cronJobResultResponseSchema.omit({ message: true }).extend({
  messageChunkCount: z.number().int().positive(),
  deliveryPending: pendingSchema.optional(),
});

export function notificationDeliveryPending(row: NotificationJobRow | null): Channel[] | null {
  if (!row) return null;
  const raw: unknown = JSON.parse(row.result_json);
  if (!raw || typeof raw !== "object" || !("deliveryPending" in raw)) return null;
  // 私有游标不是公开DTO；损坏或重复渠道必须阻断发送，不能悄悄重建并重发成功渠道。
  return metadataSchema.parse(raw).deliveryPending ?? null;
}

export async function readNotificationDelivery(env: Env, claim: NotificationJobRow): Promise<{ result: CronJobResult; chunkCount: number } | null> {
  const rows = await env.DB.prepare(`SELECT job.result_json, message.chunk_index, message.content
    FROM notification_jobs AS job LEFT JOIN notification_job_messages AS message ON message.job_id = job.id
    WHERE job.user_id = ? AND job.id = ? AND job.status = ? AND job.attempts = ? AND job.updated_at = ?
    ORDER BY message.chunk_index`).bind(claim.user_id, claim.id, claim.status, claim.attempts, claim.updated_at)
    .all<{ result_json: string; chunk_index: number | null; content: string | null }>();
  const first = rows.results[0];
  if (!first) return null;
  const parts = rows.results.map((row, index) => {
    if (row.chunk_index !== index || row.content === null) throw new Error("Notification message snapshot has a missing part");
    return row.content;
  });
  // owner、接管身份和分段来自同一读快照；不能把旧正文拼进新一轮渠道结果。
  const parsed = cronJobResultResponseSchema.parse(JSON.parse(restoreNotificationJobMessage(first.result_json, parts)));
  const items = parsed.message.items.map(({ repeatReminder, costSharing, ...item }) => ({
    ...item, ...(repeatReminder ? { repeatReminder } : {}), ...(costSharing ? { costSharing } : {}),
  }));
  return { result: { ...parsed, settings: { ...parsed.settings, locale: normalizeServerLocale(parsed.settings.locale) },
    message: { ...parsed.message, items }, channels: normalizeJobChannels(parsed.channels) }, chunkCount: parts.length };
}

export async function checkpointNotificationDelivery(
  env: Env,
  claim: NotificationJobRow,
  result: CronJobResult,
  pending: Channel[],
  chunkCount: number,
  status: NotificationJobRow["status"],
  parts?: string[],
): Promise<boolean> {
  const { message: _message, ...fields } = parts ? cronJobResultResponseSchema.parse(result) : result;
  const metadata = metadataSchema.parse({ ...fields, channels: normalizeJobChannels(fields.channels), messageChunkCount: chunkCount, ...(pending.length ? { deliveryPending: pending } : {}) });
  const timestamp = status === "sending" ? claim.updated_at : new Date(Math.max(Date.now(), Date.parse(claim.updated_at) + 1)).toISOString();
  const update = env.DB.prepare(`UPDATE notification_jobs SET status = ?, attempts = ?, last_error = ?, result_json = ?, updated_at = ?
    WHERE user_id = ? AND id = ? AND status = ? AND attempts = ? AND updated_at = ?`)
    .bind(status, claim.attempts, lastErrorFromChannels(result.channels), JSON.stringify(metadata), timestamp,
      claim.user_id, claim.id, claim.status, claim.attempts, claim.updated_at);
  // 发送前原子冻结正文和当前渠道；续接只更新小metadata，且沿用发送者身份防止迟到覆盖。
  if (parts) return (await env.DB.batch([...notificationMessageStatements(env, claim, parts), update])).at(-1)?.meta.changes === 1;
  return (await update.run()).meta.changes === 1;
}
