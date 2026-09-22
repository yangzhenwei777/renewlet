CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) >= 1 AND length(name) <= 80),
  -- Public API token 明文只在创建响应出现一次；D1 只保存 hash，避免数据库泄漏后直接接管 API。
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 43),
  token_prefix TEXT NOT NULL CHECK (length(token_prefix) BETWEEN 6 AND 16 AND substr(token_prefix, 1, 4) = 'rlt_'),
  scopes_json TEXT NOT NULL DEFAULT '["read"]' CHECK (scopes_json = '["read"]'),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user_created ON api_tokens (user_id, created_at DESC, id DESC);
