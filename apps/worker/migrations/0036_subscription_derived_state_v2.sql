-- 派生摘要彻底切到固定列，普通读取不再扫描 subscriptions 或解析 JSON 计数。
CREATE TABLE subscription_user_stats_v2 (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_count INTEGER NOT NULL DEFAULT 0,
  trial_count INTEGER NOT NULL DEFAULT 0,
  active_count INTEGER NOT NULL DEFAULT 0,
  expired_count INTEGER NOT NULL DEFAULT 0,
  paused_count INTEGER NOT NULL DEFAULT 0,
  cancelled_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (total_count >= 0 AND trial_count >= 0 AND active_count >= 0 AND expired_count >= 0 AND paused_count >= 0 AND cancelled_count >= 0),
  CHECK (total_count = trial_count + active_count + expired_count + paused_count + cancelled_count)
);

INSERT INTO subscription_user_stats_v2 (
  user_id,
  total_count,
  trial_count,
  active_count,
  expired_count,
  paused_count,
  cancelled_count,
  created_at,
  updated_at
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

DROP TABLE subscription_user_stats;
ALTER TABLE subscription_user_stats_v2 RENAME TO subscription_user_stats;

-- next_due_at_utc 依赖用户 IANA timezone；SQL migration 只建表，部署 backfill 复用 shared 调度算法后再放行新 Worker。
CREATE TABLE subscription_repeat_schedule (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  next_due_at_utc TEXT NOT NULL,
  PRIMARY KEY (user_id, subscription_id)
);

CREATE INDEX idx_subscription_repeat_schedule_due
  ON subscription_repeat_schedule (user_id, next_due_at_utc, subscription_id);

-- JS backfill 复用与 Worker 相同的 IANA timezone/repeat 算法；marker 只在全量回填和不变量校验通过后写入。
CREATE TABLE subscription_derived_backfills (
  name TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL
);
