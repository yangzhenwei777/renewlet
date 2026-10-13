-- 阶段/游标与待处理窗口属于内部进度；账号删除必须级联清理，不进入导出或Public API。
CREATE TABLE cron_progress (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('renewal', 'notification', 'webdav', 's3')),
  scheduled_at_utc TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  notification_time_local TEXT NOT NULL,
  subscription_after_id TEXT NOT NULL DEFAULT '',
  served_at_utc TEXT NOT NULL DEFAULT '',
  claim_token TEXT,
  claim_until_utc TEXT
);
CREATE INDEX idx_cron_progress_fair_order ON cron_progress(served_at_utc, user_id);

-- provider的上传/扫描/清理游标独立保留；失败的WebDAV不能阻断S3或下一天的通知。
ALTER TABLE cloud_backup_targets ADD COLUMN cron_cursor_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE cloud_backup_targets ADD COLUMN cron_claim_token TEXT;

-- 续订页按不变ID读取；日期索引需要整组排序，无法保持游标页成本。
CREATE INDEX idx_subscriptions_renewal_cursor ON subscriptions(user_id, id)
  WHERE auto_renew = 1 AND status IN ('active', 'trial');
