CREATE TABLE IF NOT EXISTS media_icon_index_refresh_jobs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('thesvg', 'selfhst', 'dashboardIcons')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error TEXT,
  artifact_hash TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_icon_index_refresh_jobs_active_provider
  ON media_icon_index_refresh_jobs (provider)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_media_icon_index_refresh_jobs_provider_queued_at
  ON media_icon_index_refresh_jobs (provider, queued_at DESC);
