-- public_hidden 默认 false：启用公开展示页后，既有订阅按用户选择“默认展示”进入公开状态投影。
ALTER TABLE subscriptions ADD COLUMN public_hidden INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public_status_pages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE CHECK (length(token) = 43),
  show_prices INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_public_status_pages_user_unique ON public_status_pages (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_public_status_pages_token ON public_status_pages (token);
