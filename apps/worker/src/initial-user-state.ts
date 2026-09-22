import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";

export interface InitialUserStateUser {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface InitialUserStateQuery {
  sql: string;
  bindings: Array<string | number>;
}

/** D1 batch 与 SQLite 原子性测试共用查询计划；账号创建始终保存 auto，不能注入请求语言。 */
export function buildInitialUserStateQueries(
  user: InitialUserStateUser,
  initialSetup: boolean,
): InitialUserStateQuery[] {
  const settings = createDefaultAppSettings();
  const userInsert: InitialUserStateQuery = initialSetup
    ? {
        sql: `
          INSERT INTO users (id, email, name, role, banned, ban_reason, password_hash, created_at, updated_at)
          SELECT ?, ?, ?, 'admin', 0, '', ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM users WHERE role = 'admin' AND banned = 0
          )
        `,
        bindings: [user.id, user.email, user.name, user.password_hash, user.created_at, user.updated_at],
      }
    : {
        sql: `
          INSERT INTO users (id, email, name, role, banned, ban_reason, password_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, 0, '', ?, ?, ?)
        `,
        bindings: [user.id, user.email, user.name, user.role, user.password_hash, user.created_at, user.updated_at],
      };

  return [
    userInsert,
    // 后三条都从刚写入的 user 条件插入；并发 setup loser 的 user 不存在，因此同一 batch 内自然保持零写入。
    {
      sql: `
        INSERT INTO settings (user_id, settings_json, created_at, updated_at)
        SELECT ?, ?, ?, ? FROM users WHERE id = ?
      `,
      bindings: [user.id, JSON.stringify(settings), user.created_at, user.updated_at, user.id],
    },
    {
      sql: `
        INSERT INTO subscription_user_stats (
          user_id, total_count, trial_count, active_count, expired_count, paused_count, cancelled_count, created_at, updated_at
        )
        SELECT id, 0, 0, 0, 0, 0, 0, ?, ? FROM users WHERE id = ?
      `,
      bindings: [user.created_at, user.updated_at, user.id],
    },
    {
      sql: `
        INSERT INTO subscription_scheduler_state (
          user_id,
          auto_renew_count,
          repeat_reminder_count,
          last_auto_renew_local_date,
          next_auto_renew_check_at_utc,
          next_daily_notification_due_at_utc,
          next_repeat_notification_due_at_utc,
          created_at,
          updated_at
        )
        SELECT id, 0, 0, '', NULL, NULL, NULL, ?, ? FROM users WHERE id = ?
      `,
      bindings: [user.created_at, user.updated_at, user.id],
    },
  ];
}
