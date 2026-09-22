DROP TABLE IF EXISTS telegram_bot_bindings_next;

CREATE TABLE telegram_bot_bindings_next (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK (length(chat_id) BETWEEN 1 AND 128),
  -- 重建表只复制当前契约列，用于把测试期已应用的旧 D1 表收敛到当前形状。
  bot_token_hash TEXT NOT NULL CHECK (length(bot_token_hash) = 43),
  webhook_secret_hash TEXT NOT NULL CHECK (length(webhook_secret_hash) = 43),
  status TEXT NOT NULL CHECK (status IN ('installing', 'installed')),
  last_update_id INTEGER NOT NULL DEFAULT 0 CHECK (last_update_id >= 0),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO telegram_bot_bindings_next (
  id,
  user_id,
  chat_id,
  bot_token_hash,
  webhook_secret_hash,
  status,
  last_update_id,
  last_used_at,
  created_at,
  updated_at
)
SELECT
  id,
  user_id,
  chat_id,
  bot_token_hash,
  webhook_secret_hash,
  status,
  last_update_id,
  last_used_at,
  created_at,
  updated_at
FROM telegram_bot_bindings;

DROP TABLE telegram_bot_bindings;

ALTER TABLE telegram_bot_bindings_next RENAME TO telegram_bot_bindings;

CREATE INDEX IF NOT EXISTS idx_telegram_bot_bindings_webhook_secret ON telegram_bot_bindings (webhook_secret_hash);
