-- D1 依靠外键级联维护新删除；这里仅清理外键启用前可能遗留的单订阅 Feed。
DELETE FROM calendar_feeds
WHERE scope = 'subscription'
  AND NOT EXISTS (
    SELECT 1
    FROM subscriptions
    WHERE subscriptions.id = calendar_feeds.subscription_id
      AND subscriptions.user_id = calendar_feeds.user_id
  );

CREATE INDEX IF NOT EXISTS idx_calendar_feeds_user_scope_updated_id
  ON calendar_feeds (user_id, scope, updated_at DESC, id DESC);
