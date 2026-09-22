CREATE TABLE media_icon_indexes_next (
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

INSERT INTO media_icon_indexes_next (
  key,
  hash,
  search_r2_key,
  detail_r2_key,
  icon_count,
  provider_counts_json,
  provider_status_json,
  checked_at,
  index_updated_at,
  locked_until,
  created_at,
  updated_at
)
SELECT
  key,
  NULL,
  NULL,
  NULL,
  0,
  '{}',
  provider_status_json,
  checked_at,
  NULL,
  NULL,
  created_at,
  updated_at
FROM media_icon_indexes;

DROP TABLE media_icon_indexes;
ALTER TABLE media_icon_indexes_next RENAME TO media_icon_indexes;
