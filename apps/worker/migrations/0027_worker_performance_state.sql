-- Cron 不再按分钟扫描 users/subscriptions；scheduler state 保存下一次 due instant，单用户逻辑仍做最终幂等判断。
ALTER TABLE subscription_scheduler_state ADD COLUMN next_auto_renew_check_at_utc TEXT;
ALTER TABLE subscription_scheduler_state ADD COLUMN next_daily_notification_due_at_utc TEXT;
ALTER TABLE subscription_scheduler_state ADD COLUMN next_repeat_notification_due_at_utc TEXT;

CREATE INDEX IF NOT EXISTS idx_subscription_scheduler_auto_due
  ON subscription_scheduler_state (next_auto_renew_check_at_utc, user_id);

CREATE INDEX IF NOT EXISTS idx_subscription_scheduler_daily_due
  ON subscription_scheduler_state (next_daily_notification_due_at_utc, user_id);

CREATE INDEX IF NOT EXISTS idx_subscription_scheduler_repeat_due
  ON subscription_scheduler_state (next_repeat_notification_due_at_utc, user_id);

ALTER TABLE cloud_backup_targets ADD COLUMN next_run_at_utc TEXT;

CREATE INDEX IF NOT EXISTS idx_cloud_backup_targets_next_run
  ON cloud_backup_targets (schedule_enabled, next_run_at_utc, user_id, provider);

-- 列表投影只服务筛选/排序/search/tag 热路径；完整 API DTO 仍以 subscriptions 行为事实源。
CREATE TABLE IF NOT EXISTS subscription_list_index (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  website TEXT,
  notes TEXT,
  search_text_lower TEXT NOT NULL,
  category TEXT NOT NULL,
  billing_cycle TEXT NOT NULL,
  currency TEXT NOT NULL,
  payment_method TEXT,
  status TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  public_hidden INTEGER NOT NULL DEFAULT 0,
  next_billing_date TEXT NOT NULL,
  trial_end_date TEXT,
  one_time_term_count INTEGER,
  auto_renew INTEGER NOT NULL DEFAULT 0,
  reminder_days INTEGER NOT NULL DEFAULT 0,
  repeat_reminder_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_order
  ON subscription_list_index (user_id, created_at DESC, subscription_id DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_category_order
  ON subscription_list_index (user_id, category, created_at DESC, subscription_id DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_billing_cycle_order
  ON subscription_list_index (user_id, billing_cycle, created_at DESC, subscription_id DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_currency_order
  ON subscription_list_index (user_id, currency, created_at DESC, subscription_id DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_payment_method_order
  ON subscription_list_index (user_id, payment_method, created_at DESC, subscription_id DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_pinned_order
  ON subscription_list_index (user_id, pinned, created_at DESC, subscription_id DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_public_hidden_order
  ON subscription_list_index (user_id, public_hidden, created_at DESC, subscription_id DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_reminder_order
  ON subscription_list_index (user_id, reminder_days, created_at DESC, subscription_id DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_list_index_user_repeat_order
  ON subscription_list_index (user_id, repeat_reminder_enabled, created_at DESC, subscription_id DESC);

CREATE TABLE IF NOT EXISTS subscription_tags (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  tag_norm TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, subscription_id, tag_norm)
);

CREATE INDEX IF NOT EXISTS idx_subscription_tags_user_tag_order
  ON subscription_tags (user_id, tag_norm, created_at DESC, subscription_id DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_tags_user_updated
  ON subscription_tags (user_id, updated_at DESC, tag_norm);

-- 用户级统计服务 total/status 摘要，避免公开/登录列表每次实时 COUNT/GROUP BY 全表。
CREATE TABLE IF NOT EXISTS subscription_user_stats (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_count INTEGER NOT NULL DEFAULT 0,
  status_counts_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR REPLACE INTO subscription_list_index (
  subscription_id,
  user_id,
  name,
  website,
  notes,
  search_text_lower,
  category,
  billing_cycle,
  currency,
  payment_method,
  status,
  pinned,
  public_hidden,
  next_billing_date,
  trial_end_date,
  one_time_term_count,
  auto_renew,
  reminder_days,
  repeat_reminder_enabled,
  created_at,
  updated_at
)
SELECT
  id,
  user_id,
  name,
  website,
  notes,
  lower(COALESCE(name, '') || ' ' || COALESCE(website, '') || ' ' || COALESCE(notes, '') || ' ' || COALESCE(tags_json, '')),
  category,
  billing_cycle,
  currency,
  payment_method,
  status,
  pinned,
  public_hidden,
  next_billing_date,
  trial_end_date,
  one_time_term_count,
  auto_renew,
  reminder_days,
  repeat_reminder_enabled,
  created_at,
  updated_at
FROM subscriptions;

INSERT OR IGNORE INTO subscription_tags (
  user_id,
  subscription_id,
  tag_norm,
  tag,
  created_at,
  updated_at
)
SELECT
  subscriptions.user_id,
  subscriptions.id,
  lower(trim(json_each.value)),
  trim(json_each.value),
  subscriptions.created_at,
  subscriptions.updated_at
FROM subscriptions, json_each(CASE WHEN json_valid(subscriptions.tags_json) THEN subscriptions.tags_json ELSE '[]' END)
WHERE json_each.type = 'text'
  AND trim(json_each.value) != '';

INSERT OR REPLACE INTO subscription_user_stats (
  user_id,
  total_count,
  status_counts_json,
  created_at,
  updated_at
)
SELECT
  users.id,
  COUNT(subscriptions.id),
  json_object(
    'active', COALESCE(SUM(CASE WHEN subscriptions.status = 'active' THEN 1 ELSE 0 END), 0),
    'trial', COALESCE(SUM(CASE WHEN subscriptions.status = 'trial' THEN 1 ELSE 0 END), 0),
    'paused', COALESCE(SUM(CASE WHEN subscriptions.status = 'paused' THEN 1 ELSE 0 END), 0),
    'cancelled', COALESCE(SUM(CASE WHEN subscriptions.status = 'cancelled' THEN 1 ELSE 0 END), 0),
    'expired', COALESCE(SUM(CASE WHEN subscriptions.status = 'expired' THEN 1 ELSE 0 END), 0)
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM users
LEFT JOIN subscriptions ON subscriptions.user_id = users.id
GROUP BY users.id;

UPDATE subscription_scheduler_state
SET
  next_auto_renew_check_at_utc = CASE WHEN auto_renew_count > 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END,
  next_daily_notification_due_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  next_repeat_notification_due_at_utc = CASE WHEN repeat_reminder_count > 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
