CREATE TABLE content_import_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  work_count integer NOT NULL CHECK (work_count BETWEEN 1 AND 100),
  piece_count integer NOT NULL CHECK (piece_count BETWEEN 1 AND 1000),
  declared_bytes bigint NOT NULL CHECK (declared_bytes BETWEEN 1 AND 107374182400),
  created_work_count integer NOT NULL CHECK (created_work_count >= 0 AND created_work_count <= work_count),
  created_piece_count integer NOT NULL CHECK (created_piece_count >= 0 AND created_piece_count <= piece_count),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, idempotency_key)
);
CREATE TABLE content_import_entries (
  group_id uuid NOT NULL REFERENCES content_import_groups(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 999),
  batch_id uuid NOT NULL UNIQUE REFERENCES ingestion_batches(id) ON DELETE RESTRICT,
  PRIMARY KEY (group_id, ordinal)
);
CREATE INDEX content_import_groups_created_idx ON content_import_groups (created_at DESC, id DESC);
