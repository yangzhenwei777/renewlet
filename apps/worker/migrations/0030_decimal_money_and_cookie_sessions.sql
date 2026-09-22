-- 金额彻底切到 canonical decimal string；旧 REAL 只在这次表重建中转成 TEXT，后续写入由 shared schema 拒绝 number。
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

PRAGMA foreign_keys = OFF;

CREATE TABLE subscriptions_decimal (
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
  extra_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO subscriptions_decimal (
  id, user_id, name, logo, price, currency, billing_cycle, custom_days, custom_cycle_unit, one_time_term_count, one_time_term_unit,
  category, status, pinned, public_hidden, payment_method, start_date, next_billing_date, auto_renew, auto_calculate_next_billing_date,
  trial_end_date, website, notes, tags_json, reminder_days, repeat_reminder_enabled, repeat_reminder_interval, repeat_reminder_window,
  cost_sharing_json, extra_json, created_at, updated_at
)
SELECT
  id, user_id, name, logo,
  CASE
    WHEN rtrim(rtrim(printf('%.6f', price), '0'), '.') = '' THEN '0'
    ELSE rtrim(rtrim(printf('%.6f', price), '0'), '.')
  END,
  currency, billing_cycle, custom_days, custom_cycle_unit, one_time_term_count, one_time_term_unit,
  category, status, pinned, public_hidden, payment_method, start_date, next_billing_date, auto_renew, auto_calculate_next_billing_date,
  trial_end_date, website, notes, tags_json, reminder_days, repeat_reminder_enabled, repeat_reminder_interval, repeat_reminder_window,
  cost_sharing_json, extra_json, created_at, updated_at
FROM subscriptions;

DROP TABLE subscriptions;
ALTER TABLE subscriptions_decimal RENAME TO subscriptions;

PRAGMA foreign_keys = ON;

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

UPDATE settings
SET settings_json = json_set(
  settings_json,
  '$.monthlyBudget',
  CASE
    WHEN rtrim(rtrim(printf('%.6f', json_extract(settings_json, '$.monthlyBudget')), '0'), '.') = '' THEN '0'
    ELSE rtrim(rtrim(printf('%.6f', json_extract(settings_json, '$.monthlyBudget')), '0'), '.')
  END
)
WHERE json_valid(settings_json)
  AND json_type(settings_json, '$.monthlyBudget') IN ('integer', 'real');

-- 只把历史 number customAmount 转 string；缺失/非法 JSON 仍交给 shared schema 在下次写入时拒绝。
UPDATE subscriptions
SET cost_sharing_json = json_set(
  cost_sharing_json,
  '$.members',
  json((
    SELECT json_group_array(
      json(CASE
        WHEN json_type(member.value, '$.customAmount') IN ('integer', 'real')
          THEN json_set(
            member.value,
            '$.customAmount',
            CASE
              WHEN rtrim(rtrim(printf('%.6f', json_extract(member.value, '$.customAmount')), '0'), '.') = '' THEN '0'
              ELSE rtrim(rtrim(printf('%.6f', json_extract(member.value, '$.customAmount')), '0'), '.')
            END
          )
        ELSE member.value
      END)
    )
    FROM json_each(cost_sharing_json, '$.members') AS member
  ))
)
WHERE json_valid(cost_sharing_json)
  AND json_type(cost_sharing_json, '$.members') = 'array';

-- Cookie session 需要独立 CSRF hash；旧 bearer-only session 没有该列值，升级后会要求重新登录。
ALTER TABLE sessions ADD COLUMN csrf_token_hash TEXT;
