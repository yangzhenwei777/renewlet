-- 订阅列表默认分页按创建时间和 id 稳定排序，避免同一时间戳记录跨页抖动。
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_created_id
  ON subscriptions (user_id, created_at DESC, id DESC);

-- 公开状态页只读取当前 owner 的可见订阅，并保持 pinned 优先、创建时间倒序的展示口径。
CREATE INDEX IF NOT EXISTS idx_public_status_visible_order
  ON subscriptions (user_id, public_hidden, pinned DESC, created_at DESC, id DESC);

-- 通知历史按用户、状态和调度时间过滤；复合索引避免历史页落回 user 全量扫描。
CREATE INDEX IF NOT EXISTS idx_notification_jobs_user_status_time
  ON notification_jobs (user_id, status, scheduled_instant_utc DESC, created_at DESC, id DESC);

-- 标签筛选只关心非空 tags_json 记录；部分索引减少普通无标签订阅对列表查询的写放大。
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_tags_updated
  ON subscriptions (user_id, updated_at DESC, id DESC) WHERE tags_json != '[]';

-- 管理员用户列表和 session 鉴权会频繁排除 banned 用户，保留 id 让分页/回表顺序稳定。
CREATE INDEX IF NOT EXISTS idx_users_banned_id
  ON users (banned, id);
