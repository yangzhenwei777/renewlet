-- 访问安全是站点级 singleton；turnstile_secret 只供 Worker Siteverify，不进入用户 settings、导出或云备份。
CREATE TABLE IF NOT EXISTS auth_security_settings (
  key TEXT PRIMARY KEY CHECK (key = 'global'),
  turnstile_enabled INTEGER NOT NULL DEFAULT 0 CHECK (turnstile_enabled IN (0, 1)),
  turnstile_site_key TEXT NOT NULL DEFAULT '',
  turnstile_secret TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
