-- subscription_user_stats 是可重建投影的用户级摘要；source_updated_at 用于发现同数量旧投影，不参与业务导出。
ALTER TABLE subscription_user_stats ADD COLUMN source_updated_at TEXT NOT NULL DEFAULT '';
