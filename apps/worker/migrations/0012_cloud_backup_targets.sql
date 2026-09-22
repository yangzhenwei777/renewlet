CREATE TABLE IF NOT EXISTS cloud_backup_targets (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('webdav', 's3')),
  config_json TEXT NOT NULL DEFAULT '{}',
  -- 每个 provider 独立保存 write-only secret；响应只能返回 credentialSet，不允许明文回显。
  credential_json TEXT NOT NULL DEFAULT '{}',
  schedule_enabled INTEGER NOT NULL DEFAULT 0,
  schedule_frequency TEXT NOT NULL DEFAULT 'daily' CHECK (schedule_frequency IN ('daily', 'weekly')),
  schedule_time TEXT NOT NULL DEFAULT '03:00' CHECK (schedule_time GLOB '[0-2][0-9]:[0-5][0-9]' AND CAST(substr(schedule_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23),
  schedule_weekday TEXT NOT NULL DEFAULT 'monday' CHECK (schedule_weekday IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')),
  retention INTEGER NOT NULL DEFAULT 7 CHECK (retention >= 1 AND retention <= 30),
  last_backup_at TEXT,
  last_status TEXT NOT NULL DEFAULT 'idle' CHECK (last_status IN ('idle', 'success', 'failed')),
  last_error TEXT,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_cloud_backup_targets_schedule ON cloud_backup_targets (schedule_enabled, updated_at);

INSERT OR IGNORE INTO cloud_backup_targets (
  user_id, provider, config_json, credential_json, schedule_enabled, schedule_frequency, schedule_time,
  schedule_weekday, retention, last_backup_at, last_status, last_error, locked_until, created_at, updated_at
)
SELECT
  user_id,
  'webdav',
  json_object('webdav', json_extract(config_json, '$.webdav')),
  json_object('webdavPassword', json_extract(credential_json, '$.webdavPassword')),
  schedule_enabled,
  schedule_frequency,
  '03:00',
  'monday',
  retention,
  last_backup_at,
  last_status,
  last_error,
  NULL,
  created_at,
  updated_at
FROM cloud_backup_configs
WHERE json_type(config_json, '$.webdav') IS NOT NULL OR json_extract(credential_json, '$.webdavPassword') IS NOT NULL;

INSERT OR IGNORE INTO cloud_backup_targets (
  user_id, provider, config_json, credential_json, schedule_enabled, schedule_frequency, schedule_time,
  schedule_weekday, retention, last_backup_at, last_status, last_error, locked_until, created_at, updated_at
)
SELECT
  user_id,
  's3',
  json_object('s3', json_extract(config_json, '$.s3')),
  json_object('s3SecretAccessKey', json_extract(credential_json, '$.s3SecretAccessKey')),
  schedule_enabled,
  schedule_frequency,
  '03:00',
  'monday',
  retention,
  last_backup_at,
  last_status,
  last_error,
  NULL,
  created_at,
  updated_at
FROM cloud_backup_configs
WHERE json_type(config_json, '$.s3') IS NOT NULL OR json_extract(credential_json, '$.s3SecretAccessKey') IS NOT NULL;
