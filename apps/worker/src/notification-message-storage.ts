import { cronJobResultResponseSchema } from "@renewlet/shared/schemas/notifications";
import { NOTIFICATION_JOB_COLUMNS } from "./db";
import type { Env, NotificationJobRow } from "./types";

const messageChunkCharacters = 8192;

export function splitNotificationJobMessage(result: unknown, preparedParts?: string[]): { metadata: string; parts: string[] } {
  const { message, ...metadata } = cronJobResultResponseSchema.parse(result);
  const parts = preparedParts ?? notificationMessageParts(message);
  return { metadata: JSON.stringify({ ...metadata, messageChunkCount: parts.length }), parts };
}

export function notificationMessageParts(message: unknown): string[] {
  // 与 Go/SQLite substr 统一按 Unicode 码点计数；快照总大小不再决定任务 JSON 能否提交。
  const characters = Array.from(JSON.stringify(message));
  const parts: string[] = [];
  for (let start = 0; start < characters.length; start += messageChunkCharacters) {
    parts.push(characters.slice(start, start + messageChunkCharacters).join(""));
  }
  return parts;
}

export function notificationMessageWriteCount(parts: readonly string[]): number {
  return 2 + Math.ceil(parts.length / 16);
}

export function notificationMessageStatements(env: Env, claim: NotificationJobRow, parts: string[]): D1PreparedStatement[] {
  const ownership = "EXISTS (SELECT 1 FROM notification_jobs WHERE id = ? AND user_id = ? AND status = ? AND attempts = ? AND updated_at = ?)";
  const identity = [claim.id, claim.user_id, claim.status, claim.attempts, claim.updated_at];
  // 只保护最终UPDATE不足以保护快照；DELETE/INSERT必须在同一batch内通过相同身份检查。
  const statements = [env.DB.prepare(`DELETE FROM notification_job_messages WHERE job_id = ? AND ${ownership}`).bind(claim.id, ...identity)];
  // 单批最多 16 段，包含转义也不接近 D1 单值限制；调用者与最终状态放进同一次 batch。
  for (let start = 0; start < parts.length; start += 16) {
    statements.push(env.DB.prepare(`INSERT INTO notification_job_messages (job_id, chunk_index, content)
      SELECT ?, ? + CAST(key AS INTEGER), value FROM json_each(?) WHERE ${ownership}`).bind(claim.id, start, JSON.stringify(parts.slice(start, start + 16)), ...identity));
  }
  return statements;
}

export function restoreNotificationJobMessage(metadata: string, parts: string[]): string {
  let fields: unknown;
  try { fields = JSON.parse(metadata); } catch { return "{}"; }
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !("messageChunkCount" in fields)) return "{}";
  const { messageChunkCount, ...metadataFields } = fields;
  // 渠道续接仅供Worker调度器使用，历史API继续满足两端相同的严格公开schema。
  const { deliveryPending: _pending, ...result } = metadataFields as Record<string, unknown>;
  // 分段数属于完整性校验，不是兼容版本；缺段不能伪装成“这次没有通知内容”。
  if (!Number.isInteger(messageChunkCount) || messageChunkCount !== parts.length || parts.length === 0) {
    throw new Error("Notification message snapshot is incomplete");
  }
  return JSON.stringify({ ...result, message: JSON.parse(parts.join("")) as unknown });
}

type NotificationMessageRow = NotificationJobRow & { chunk_index: number | null; content: string | null };

export async function readNotificationHistoryRows(env: Env, userId: string, status: string, limit: number, offset = 0): Promise<NotificationJobRow[]> {
  const params: (string | number)[] = [userId];
  let filter = "WHERE user_id = ?";
  if (status !== "all") { filter += " AND status = ?"; params.push(status); }
  params.push(limit, offset);
  // 先按账号分页；单条查询同时读状态和分段，避免并发重试让两次读拼出不同版本。
  const rows = await env.DB.prepare(`WITH page AS (
    SELECT ${NOTIFICATION_JOB_COLUMNS} FROM notification_jobs ${filter} ORDER BY scheduled_instant_utc DESC, created_at DESC LIMIT ? OFFSET ?
  ) SELECT page.*, messages.chunk_index, messages.content FROM page
  LEFT JOIN notification_job_messages AS messages ON messages.job_id = page.id
  ORDER BY page.scheduled_instant_utc DESC, page.created_at DESC, page.id, messages.chunk_index`).bind(...params).all<NotificationMessageRow>();
  const jobs: NotificationJobRow[] = [];
  for (let start = 0; start < rows.results.length;) {
    const row = rows.results[start];
    if (!row) break;
    const parts: string[] = [];
    let end = start;
    while (rows.results[end]?.id === row.id) {
      const part = rows.results[end];
      if (!part) break;
      if (part.chunk_index !== null) {
        if (part.chunk_index !== parts.length || part.content === null) throw new Error("Notification message snapshot has a missing part");
        parts.push(part.content);
      }
      end++;
    }
    const { chunk_index: _chunkIndex, content: _content, ...job } = row;
    jobs.push({ ...job, result_json: restoreNotificationJobMessage(row.result_json, parts) });
    start = end;
  }
  return jobs;
}
