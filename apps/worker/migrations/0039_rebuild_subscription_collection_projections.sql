-- 0035 在 D1 外键恒开启时会级联删除集合投影；本 migration 先恢复可查询基线，避免部署窗口内旧 Worker 返回空集合。
-- SQLite 的 lower/group_concat 不是最终 Unicode 口径；migration 后的 v3 backfill 会复用 Worker 规范化逻辑逐字段覆盖并校验。
DELETE FROM subscription_list_index;

INSERT INTO subscription_list_index (
  subscription_id, user_id, name, website, notes, search_text_lower, category, billing_cycle, currency,
  payment_method, status, pinned, public_hidden, next_billing_date, trial_end_date, one_time_term_count,
  auto_renew, reminder_days, repeat_reminder_enabled, created_at, updated_at
)
SELECT
  subscriptions.id,
  subscriptions.user_id,
  subscriptions.name,
  subscriptions.website,
  subscriptions.notes,
  lower(
    subscriptions.name || char(10)
    || COALESCE(subscriptions.website, '') || char(10)
    || COALESCE(subscriptions.notes, '') || char(10)
    || COALESCE((
      SELECT group_concat(TRIM(CAST(tags.value AS TEXT)), char(10))
      FROM json_each(
        CASE
          WHEN json_valid(subscriptions.tags_json)
          THEN CASE WHEN json_type(subscriptions.tags_json) = 'array' THEN subscriptions.tags_json ELSE '[]' END
          ELSE '[]'
        END
      ) AS tags
      WHERE tags.type = 'text' AND TRIM(CAST(tags.value AS TEXT)) != ''
    ), '')
  ),
  subscriptions.category,
  subscriptions.billing_cycle,
  subscriptions.currency,
  subscriptions.payment_method,
  subscriptions.status,
  subscriptions.pinned,
  subscriptions.public_hidden,
  subscriptions.next_billing_date,
  subscriptions.trial_end_date,
  subscriptions.one_time_term_count,
  subscriptions.auto_renew,
  subscriptions.reminder_days,
  subscriptions.repeat_reminder_enabled,
  subscriptions.created_at,
  subscriptions.updated_at
FROM subscriptions;

-- tags_json 是事实源；先清空投影可同时去掉错误 owner、缺失事实和旧规范化规则留下的孤儿行。
DELETE FROM subscription_tags;

INSERT INTO subscription_tags (user_id, subscription_id, tag_norm, tag, created_at, updated_at)
SELECT
  subscriptions.user_id,
  subscriptions.id,
  lower(TRIM(CAST(tags.value AS TEXT))),
  MAX(TRIM(CAST(tags.value AS TEXT))),
  subscriptions.created_at,
  subscriptions.updated_at
FROM subscriptions
JOIN json_each(
  CASE
    WHEN json_valid(subscriptions.tags_json)
    THEN CASE WHEN json_type(subscriptions.tags_json) = 'array' THEN subscriptions.tags_json ELSE '[]' END
    ELSE '[]'
  END
) AS tags
WHERE tags.type = 'text' AND TRIM(CAST(tags.value AS TEXT)) != ''
GROUP BY subscriptions.user_id, subscriptions.id, lower(TRIM(CAST(tags.value AS TEXT))), subscriptions.created_at, subscriptions.updated_at;

-- 所有用户都必须有固定列统计行，包括零订阅用户；请求热路径不能退回 subscriptions 全表聚合兜底。
DELETE FROM subscription_user_stats;

INSERT INTO subscription_user_stats (
  user_id, total_count, trial_count, active_count, expired_count, paused_count, cancelled_count, created_at, updated_at
)
SELECT
  users.id,
  COUNT(subscriptions.id),
  COALESCE(SUM(CASE WHEN subscriptions.status = 'trial' THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN subscriptions.status = 'active' THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN subscriptions.status = 'expired' THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN subscriptions.status = 'paused' THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN subscriptions.status = 'cancelled' THEN 1 ELSE 0 END), 0),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM users
LEFT JOIN subscriptions ON subscriptions.user_id = users.id
GROUP BY users.id;
