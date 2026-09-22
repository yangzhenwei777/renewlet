CREATE TABLE IF NOT EXISTS mfa_totp_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- TOTP seed 只能加密保存；备份、导出和普通 settings payload 都不能读取这张表。
  secret_ciphertext TEXT NOT NULL,
  last_accepted_step INTEGER NOT NULL DEFAULT 0 CHECK (last_accepted_step >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 恢复码明文只在生成响应出现一次；D1 只保存带安装级账号安全密钥的 HMAC。
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 43),
  used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, code_hash)
);

CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user_used ON mfa_recovery_codes (user_id, used_at);

CREATE TABLE IF NOT EXISTS passkey_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  credential_json TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkey_credentials (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mfa_auth_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- ticket 表示“密码已通过但二因子未完成”，短期、限次数、成功后一次性删除。
  ticket_hash TEXT NOT NULL UNIQUE CHECK (length(ticket_hash) = 43),
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
  methods_json TEXT NOT NULL,
  payload_ciphertext TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mfa_tickets_user_expires ON mfa_auth_tickets (user_id, expires_at);

CREATE TABLE IF NOT EXISTS passkey_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  challenge_id_hash TEXT NOT NULL UNIQUE CHECK (length(challenge_id_hash) = 43),
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
  challenge TEXT NOT NULL,
  -- 独立 Passkey 登录开始时用户未知；finish 阶段再通过 credential 反查账号并校验 RP/origin。
  session_data_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_passkey_challenges_user_kind ON passkey_challenges (user_id, kind);
