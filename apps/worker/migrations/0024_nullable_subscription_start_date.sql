DROP INDEX IF EXISTS idx_subscriptions_user_created;
DROP INDEX IF EXISTS idx_subscriptions_user_next_billing;
DROP INDEX IF EXISTS idx_subscriptions_user_logo;
DROP INDEX IF EXISTS idx_subscriptions_user_auto_renew_due;
DROP INDEX IF EXISTS idx_subscriptions_user_reminder_due;
DROP INDEX IF EXISTS idx_subscriptions_user_trial_reminder;
DROP INDEX IF EXISTS idx_subscriptions_user_repeat_reminder;
DROP INDEX IF EXISTS idx_subscriptions_user_repeat_trial_reminder;

PRAGMA foreign_keys = OFF;

CREATE TABLE subscriptions_new (
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
  -- D1 不能直接 DROP NOT NULL；重建表后 start_date 才能承载 shared 的“周期订阅未知开始日”契约。
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
  extra_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO subscriptions_new (
  id, user_id, name, logo, price, currency, billing_cycle, custom_days, custom_cycle_unit, one_time_term_count, one_time_term_unit,
  category, status, pinned, public_hidden, payment_method, start_date, next_billing_date, auto_renew, auto_calculate_next_billing_date,
  trial_end_date, website, notes, tags_json, reminder_days, repeat_reminder_enabled, repeat_reminder_interval, repeat_reminder_window,
  cost_sharing_json, extra_json, created_at, updated_at
)
SELECT
  id, user_id, name, logo, price, currency, billing_cycle, custom_days, custom_cycle_unit, one_time_term_count, one_time_term_unit,
  category, status, pinned, public_hidden, payment_method, start_date, next_billing_date, auto_renew, auto_calculate_next_billing_date,
  trial_end_date, website, notes, tags_json, reminder_days, repeat_reminder_enabled, repeat_reminder_interval, repeat_reminder_window,
  cost_sharing_json, extra_json, created_at, updated_at
FROM subscriptions;

DROP TABLE subscriptions;
ALTER TABLE subscriptions_new RENAME TO subscriptions;

PRAGMA foreign_keys = ON;

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_created ON subscriptions (user_id, created_at DESC);
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
