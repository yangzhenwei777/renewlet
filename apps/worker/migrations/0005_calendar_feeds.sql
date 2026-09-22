CREATE TABLE IF NOT EXISTS calendar_feeds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('all', 'subscription')),
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
  -- ICS 客户端只能按 URL 拉取；这里保存可恢复 token，让登录用户刷新后仍能复制自己的订阅地址。
  token TEXT NOT NULL UNIQUE CHECK (length(token) = 43),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (scope = 'all' AND subscription_id IS NULL)
    OR (scope = 'subscription' AND subscription_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_feeds_user_all_unique ON calendar_feeds (user_id) WHERE scope = 'all';
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_feeds_token ON calendar_feeds (token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_feeds_user_subscription_unique ON calendar_feeds (user_id, subscription_id) WHERE scope = 'subscription';
