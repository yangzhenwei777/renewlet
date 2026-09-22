CREATE TABLE IF NOT EXISTS telegram_bot_bindings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK (length(chat_id) BETWEEN 1 AND 128),
  -- Telegram webhook secret 和 Bot Token 只保存 hash；明文只在安装调用 Telegram API 时短暂存在。
  bot_token_hash TEXT NOT NULL CHECK (length(bot_token_hash) = 43),
  webhook_secret_hash TEXT NOT NULL CHECK (length(webhook_secret_hash) = 43),
  status TEXT NOT NULL CHECK (status IN ('installing', 'installed')),
  last_update_id INTEGER NOT NULL DEFAULT 0 CHECK (last_update_id >= 0),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_bot_bindings_webhook_secret ON telegram_bot_bindings (webhook_secret_hash);
