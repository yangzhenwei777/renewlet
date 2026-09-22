-- 通知/续订 cron 只读候选集合；这些索引用来避免每分钟 scheduled tick 按用户全量 subscriptions 计费读取。
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_auto_renew_due
  ON subscriptions (user_id, auto_renew, status, billing_cycle, next_billing_date);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_reminder_due
  ON subscriptions (user_id, reminder_days, next_billing_date);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_trial_reminder
  ON subscriptions (user_id, reminder_days, trial_end_date);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_repeat_reminder
  ON subscriptions (user_id, repeat_reminder_enabled, reminder_days, next_billing_date);
