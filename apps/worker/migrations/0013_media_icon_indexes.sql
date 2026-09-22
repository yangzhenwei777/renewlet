CREATE TABLE IF NOT EXISTS media_icon_indexes (
  key TEXT PRIMARY KEY CHECK (key = 'active'),
  hash TEXT,
  search_r2_key TEXT,
  detail_r2_key TEXT,
  icon_count INTEGER NOT NULL DEFAULT 0 CHECK (icon_count >= 0),
  provider_counts_json TEXT NOT NULL DEFAULT '{}',
  provider_status_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT,
  index_updated_at TEXT,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
