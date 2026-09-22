ALTER TABLE subscriptions ADD COLUMN cost_sharing_collection_reminder_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN cost_sharing_next_collection_reminder_date TEXT;

-- cost_sharing_json 是公共配置事实源；迁移只移除上一版短暂公开过的 intervalMonths，不保存派生周期。
UPDATE subscriptions
SET cost_sharing_json = json_remove(cost_sharing_json, '$.collectionReminder.intervalMonths')
WHERE json_valid(cost_sharing_json)
  AND json_type(cost_sharing_json, '$.collectionReminder.intervalMonths') IS NOT NULL;

-- D1 migration 不在 SQL 里复刻成员周期算法，只把启用记录带入下一次索引候选后由 Worker 精确重算。
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

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_reminder_date_due
  ON subscriptions (user_id, next_billing_date, id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_trial_reminder_date_due
  ON subscriptions (user_id, trial_end_date, id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_cost_sharing_collection_due
  ON subscriptions (user_id, cost_sharing_collection_reminder_enabled, cost_sharing_next_collection_reminder_date, id);
