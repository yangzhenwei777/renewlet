CREATE TABLE IF NOT EXISTS subscription_scheduler_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  auto_renew_count INTEGER NOT NULL DEFAULT 0,
  repeat_reminder_count INTEGER NOT NULL DEFAULT 0,
  last_auto_renew_local_date TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO subscription_scheduler_state (
  user_id,
  auto_renew_count,
  repeat_reminder_count,
  last_auto_renew_local_date,
  created_at,
  updated_at
)
SELECT
  users.id,
  COALESCE(SUM(CASE WHEN subscriptions.auto_renew = 1 THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN subscriptions.repeat_reminder_enabled = 1 THEN 1 ELSE 0 END), 0),
  '',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM users
LEFT JOIN subscriptions ON subscriptions.user_id = users.id
GROUP BY users.id
ON CONFLICT(user_id) DO UPDATE SET
  auto_renew_count = excluded.auto_renew_count,
  repeat_reminder_count = excluded.repeat_reminder_count,
  updated_at = excluded.updated_at;

DROP INDEX IF EXISTS idx_subscriptions_user_auto_renew_due;
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_auto_renew_due
  ON subscriptions (user_id, auto_renew, next_billing_date, id);

DROP INDEX IF EXISTS idx_subscriptions_user_reminder_due;
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_reminder_due
  ON subscriptions (user_id, next_billing_date, id);

DROP INDEX IF EXISTS idx_subscriptions_user_trial_reminder;
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_trial_reminder
  ON subscriptions (user_id, trial_end_date, id);

DROP INDEX IF EXISTS idx_subscriptions_user_repeat_reminder;
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_repeat_reminder
  ON subscriptions (user_id, repeat_reminder_enabled, next_billing_date, id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_repeat_trial_reminder
  ON subscriptions (user_id, repeat_reminder_enabled, status, trial_end_date, id);
