CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
  banned INTEGER NOT NULL DEFAULT 0,
  ban_reason TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  reset_token_hash TEXT,
  reset_token_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_role_banned ON users (role, banned);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  -- 产品 session token 只进 HttpOnly cookie；D1 只存 hash，泄库不能直接接管会话。
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  logo TEXT,
  price TEXT NOT NULL,
  currency TEXT NOT NULL,
  billing_cycle TEXT NOT NULL,
  custom_days INTEGER,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  payment_method TEXT,
  start_date TEXT NOT NULL,
  next_billing_date TEXT NOT NULL,
  auto_calculate_next_billing_date INTEGER NOT NULL,
  trial_end_date TEXT,
  website TEXT,
  notes TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  reminder_days INTEGER NOT NULL,
  repeat_reminder_enabled INTEGER NOT NULL,
  repeat_reminder_interval TEXT NOT NULL,
  repeat_reminder_window TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_created ON subscriptions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_next_billing ON subscriptions (user_id, next_billing_date);

CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_configs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  -- R2 key 不公开；所有私有资产读取先过这张 owner metadata 表。
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('logo', 'icon')),
  r2_key TEXT NOT NULL UNIQUE,
  original_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assets_user_kind_updated ON assets (user_id, kind, updated_at DESC);

-- Cron 每分钟触发；唯一键把同一用户的同一本地调度窗口压成一次通知作业。
CREATE TABLE IF NOT EXISTS notification_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_local_date TEXT NOT NULL,
  scheduled_local_time TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  scheduled_instant_utc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, scheduled_local_date, scheduled_local_time, time_zone)
);

CREATE INDEX IF NOT EXISTS idx_notification_jobs_user_created ON notification_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_status ON notification_jobs (status, scheduled_instant_utc);
