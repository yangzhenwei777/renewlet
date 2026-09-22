ALTER TABLE media_icon_index_refresh_jobs ADD COLUMN index_hash TEXT;

UPDATE media_icon_index_refresh_jobs
SET index_hash = artifact_hash
WHERE index_hash IS NULL AND artifact_hash IS NOT NULL;
