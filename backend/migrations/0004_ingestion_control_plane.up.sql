CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('content_admin', 'operations_admin')),
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

ALTER TABLE ingestion_batches
  ADD COLUMN request_hash char(64) CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN source_commit_sha text,
  ADD COLUMN tool_version text,
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object');

UPDATE ingestion_batches SET request_hash = repeat('0', 64) WHERE request_hash IS NULL;
ALTER TABLE ingestion_batches ALTER COLUMN request_hash SET NOT NULL;

ALTER TABLE upload_sessions
  ADD COLUMN request_hash char(64) CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN part_count integer CHECK (part_count BETWEEN 1 AND 10000);

UPDATE upload_sessions
SET request_hash = repeat('0', 64), part_count = 1
WHERE request_hash IS NULL OR part_count IS NULL;

ALTER TABLE upload_sessions ALTER COLUMN request_hash SET NOT NULL;
ALTER TABLE upload_sessions ALTER COLUMN part_count SET NOT NULL;

ALTER TABLE content_versions
  ADD COLUMN provenance jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance) = 'object');
