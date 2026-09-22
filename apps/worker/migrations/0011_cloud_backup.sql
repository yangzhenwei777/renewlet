CREATE TABLE IF NOT EXISTS cloud_backup_configs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT 'webdav' CHECK (provider IN ('webdav', 's3')),
  config_json TEXT NOT NULL DEFAULT '{}',
  -- 云存储凭据是 write-only secret；API 只返回 credentialSet，普通导出和云快照都不能读取后打包。
  credential_json TEXT NOT NULL DEFAULT '{}',
  schedule_enabled INTEGER NOT NULL DEFAULT 0,
  schedule_frequency TEXT NOT NULL DEFAULT 'daily' CHECK (schedule_frequency IN ('daily', 'weekly')),
  retention INTEGER NOT NULL DEFAULT 7 CHECK (retention >= 1 AND retention <= 30),
  last_backup_at TEXT,
  last_status TEXT NOT NULL DEFAULT 'idle' CHECK (last_status IN ('idle', 'success', 'failed')),
  last_error TEXT,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_backup_configs_schedule ON cloud_backup_configs (enabled, schedule_enabled, updated_at);
