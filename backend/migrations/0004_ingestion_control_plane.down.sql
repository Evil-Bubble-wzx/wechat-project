ALTER TABLE content_versions DROP COLUMN IF EXISTS provenance;
ALTER TABLE upload_sessions DROP COLUMN IF EXISTS part_count;
ALTER TABLE upload_sessions DROP COLUMN IF EXISTS request_hash;
ALTER TABLE ingestion_batches DROP COLUMN IF EXISTS metadata;
ALTER TABLE ingestion_batches DROP COLUMN IF EXISTS tool_version;
ALTER TABLE ingestion_batches DROP COLUMN IF EXISTS source_commit_sha;
ALTER TABLE ingestion_batches DROP COLUMN IF EXISTS request_hash;
DROP TABLE IF EXISTS user_roles;
