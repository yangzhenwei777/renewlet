DROP INDEX IF EXISTS idx_subscriptions_user_created;
DROP INDEX IF EXISTS idx_subscriptions_user_created_id;
DROP INDEX IF EXISTS idx_subscriptions_user_next_billing;
DROP INDEX IF EXISTS idx_subscriptions_user_logo;
DROP INDEX IF EXISTS idx_subscriptions_user_auto_renew_due;
DROP INDEX IF EXISTS idx_subscriptions_user_reminder_due;
DROP INDEX IF EXISTS idx_subscriptions_user_trial_reminder;
DROP INDEX IF EXISTS idx_subscriptions_user_repeat_reminder;
DROP INDEX IF EXISTS idx_subscriptions_user_repeat_trial_reminder;
DROP INDEX IF EXISTS idx_public_status_visible_order;
DROP INDEX IF EXISTS idx_subscriptions_user_tags_updated;
DROP INDEX IF EXISTS idx_subscriptions_user_category_order;
DROP INDEX IF EXISTS idx_subscriptions_user_billing_cycle_order;
DROP INDEX IF EXISTS idx_subscriptions_user_currency_order;
DROP INDEX IF EXISTS idx_subscriptions_user_payment_method_order;
DROP INDEX IF EXISTS idx_subscriptions_user_pinned_order;
DROP INDEX IF EXISTS idx_subscriptions_user_public_hidden_order;
DROP INDEX IF EXISTS idx_subscriptions_user_reminder_mode_order;
DROP INDEX IF EXISTS idx_subscriptions_user_repeat_reminder_order;
DROP INDEX IF EXISTS idx_subscriptions_user_reminder_date_due;
DROP INDEX IF EXISTS idx_subscriptions_user_trial_reminder_date_due;
DROP INDEX IF EXISTS idx_subscriptions_user_cost_sharing_collection_due;

PRAGMA foreign_keys = OFF;

-- 先建新表再替换旧表，避免 ALTER TABLE RENAME 把 calendar/list/tag 等子表外键改绑到临时旧表名。
CREATE TABLE subscriptions_0035_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  logo TEXT,
  price TEXT NOT NULL,
  currency TEXT NOT NULL,
  billing_cycle TEXT NOT NULL,
  custom_days INTEGER,
  custom_cycle_unit TEXT,
  one_time_term_count INTEGER,
  one_time_term_unit TEXT,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  public_hidden INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,
  start_date TEXT,
  next_billing_date TEXT NOT NULL,
  auto_renew INTEGER NOT NULL DEFAULT 0,
  auto_calculate_next_billing_date INTEGER NOT NULL,
  trial_end_date TEXT,
  website TEXT,
  notes TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  reminder_days INTEGER NOT NULL,
  repeat_reminder_enabled INTEGER NOT NULL,
  repeat_reminder_interval TEXT NOT NULL,
  repeat_reminder_window TEXT NOT NULL,
  cost_sharing_json TEXT NOT NULL DEFAULT '{}',
  cost_sharing_collection_reminder_enabled INTEGER NOT NULL DEFAULT 0,
  cost_sharing_next_collection_reminder_date TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO subscriptions_0035_new (
  id, user_id, name, logo, price, currency, billing_cycle, custom_days, custom_cycle_unit, one_time_term_count, one_time_term_unit,
  category, status, pinned, public_hidden, payment_method, start_date, next_billing_date, auto_renew, auto_calculate_next_billing_date,
  trial_end_date, website, notes, tags_json, reminder_days, repeat_reminder_enabled, repeat_reminder_interval, repeat_reminder_window,
  cost_sharing_json, cost_sharing_collection_reminder_enabled, cost_sharing_next_collection_reminder_date, extra_json, created_at, updated_at
)
SELECT
  id, user_id, name, logo, price, currency, billing_cycle, custom_days, custom_cycle_unit, one_time_term_count, one_time_term_unit,
  category, status, pinned, public_hidden, payment_method, start_date, next_billing_date, auto_renew, auto_calculate_next_billing_date,
  trial_end_date, website, notes, tags_json, reminder_days, repeat_reminder_enabled, repeat_reminder_interval, repeat_reminder_window,
  cost_sharing_json, 0, NULL, extra_json, created_at, updated_at
FROM subscriptions;

-- 复制阶段不读取 0034 的旧/新差异列；镜像字段统一在下方从 cost_sharing_json 重算，保证两类旧库都能升级。
DROP TABLE subscriptions;
ALTER TABLE subscriptions_0035_new RENAME TO subscriptions;

PRAGMA foreign_keys = ON;

-- 0034 曾在开发期以同名不同列执行过；这里用表重建强制收敛 D1 schema，避免 Wrangler 跳过已记账文件。
UPDATE subscriptions
SET cost_sharing_json = json_remove(cost_sharing_json, '$.collectionReminder.intervalMonths')
WHERE json_valid(cost_sharing_json)
  AND json_type(cost_sharing_json, '$.collectionReminder.intervalMonths') IS NOT NULL;

-- 镜像列只服务通知候选索引；真实收款提醒配置仍以 cost_sharing_json 为事实源。
UPDATE subscriptions
SET
  cost_sharing_collection_reminder_enabled = CASE
    WHEN json_valid(cost_sharing_json)
      AND json_extract(cost_sharing_json, '$.enabled') = 1
      AND json_extract(cost_sharing_json, '$.collectionReminder.enabled') = 1
      AND (billing_cycle != 'one-time' OR one_time_term_count IS NOT NULL)
    THEN 1
    ELSE 0
  END,
  cost_sharing_next_collection_reminder_date = CASE
    WHEN json_valid(cost_sharing_json)
      AND json_extract(cost_sharing_json, '$.enabled') = 1
      AND json_extract(cost_sharing_json, '$.collectionReminder.enabled') = 1
      AND (billing_cycle != 'one-time' OR one_time_term_count IS NOT NULL)
    THEN date('now')
    ELSE NULL
  END;

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_created ON subscriptions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_created_id ON subscriptions (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_next_billing ON subscriptions (user_id, next_billing_date);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_logo ON subscriptions (user_id, logo);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_auto_renew_due
  ON subscriptions (user_id, auto_renew, next_billing_date, id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_reminder_due
  ON subscriptions (user_id, next_billing_date, id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_trial_reminder
  ON subscriptions (user_id, trial_end_date, id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_repeat_reminder
  ON subscriptions (user_id, repeat_reminder_enabled, next_billing_date, id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_repeat_trial_reminder
  ON subscriptions (user_id, repeat_reminder_enabled, status, trial_end_date, id);
CREATE INDEX IF NOT EXISTS idx_public_status_visible_order
  ON subscriptions (user_id, public_hidden, pinned DESC, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_tags_updated
  ON subscriptions (user_id, updated_at DESC, id DESC) WHERE tags_json != '[]';
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_category_order
  ON subscriptions (user_id, category, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_billing_cycle_order
  ON subscriptions (user_id, billing_cycle, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_currency_order
  ON subscriptions (user_id, currency, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_payment_method_order
  ON subscriptions (user_id, payment_method, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_pinned_order
  ON subscriptions (user_id, pinned, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_public_hidden_order
  ON subscriptions (user_id, public_hidden, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_reminder_mode_order
  ON subscriptions (user_id, reminder_days, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_repeat_reminder_order
  ON subscriptions (user_id, repeat_reminder_enabled, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_reminder_date_due
  ON subscriptions (user_id, next_billing_date, id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_trial_reminder_date_due
  ON subscriptions (user_id, trial_end_date, id);

-- 收款提醒 cron 只读这个 owner-scoped due 索引缩候选；不要改回 JSON predicate 或 next_billing_date 近似索引。
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_cost_sharing_collection_due
  ON subscriptions (user_id, cost_sharing_collection_reminder_enabled, cost_sharing_next_collection_reminder_date, id);
