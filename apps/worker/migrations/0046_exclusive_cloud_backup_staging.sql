-- 登记先于R2写入；不能随账号级联删除，否则崩溃/删除账号后会失去孤儿对象的回收依据。
CREATE TABLE cloud_backup_staging (
  r2_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_cloud_backup_staging_age ON cloud_backup_staging(created_at, r2_key);
-- 两侧统一TEXT affinity，SQLite才会对相关子查询使用表达式索引查找，而不是扫描整个引用索引。
CREATE INDEX idx_cloud_backup_staging_reference ON cloud_backup_targets(CAST(json_extract(cron_cursor_json, '$.stagingKey') AS TEXT));

-- 旧upload阶段尚未拥有本地快照；保留固定ID/调度窗口，升级后先准备资产再上传。
UPDATE cloud_backup_targets SET cron_cursor_json = json_set(cron_cursor_json, '$.stage', 'prepare', '$.stagingKey', NULL)
  WHERE json_extract(cron_cursor_json, '$.stage') = 'upload';
