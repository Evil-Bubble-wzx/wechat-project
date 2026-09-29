CREATE SEQUENCE user_learning_progress_change_seq AS bigint;

ALTER TABLE user_learning_progress
  ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  ADD COLUMN natural_end_observed boolean NOT NULL DEFAULT false,
  ADD COLUMN server_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_device_id text,
  ADD COLUMN source_kind text NOT NULL DEFAULT 's01_local_import'
    CHECK (source_kind IN ('s01_local_import', 's02_daily_sync')),
  ADD COLUMN change_seq bigint;

UPDATE user_learning_progress
SET change_seq = nextval('user_learning_progress_change_seq');

ALTER TABLE user_learning_progress
  ALTER COLUMN change_seq SET NOT NULL;

CREATE INDEX user_learning_progress_user_change_idx
ON user_learning_progress (user_id, change_seq);

CREATE TABLE user_learning_progress_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  piece_id text NOT NULL REFERENCES pieces(id) ON DELETE RESTRICT,
  content_version integer NOT NULL CHECK (content_version >= 1),
  duration_ms integer NOT NULL CHECK (duration_ms > 0),
  revision bigint NOT NULL CHECK (revision >= 1),
  checkpoint_ms integer NOT NULL CHECK (checkpoint_ms BETWEEN 0 AND duration_ms),
  listened_ranges_ms jsonb NOT NULL CHECK (jsonb_typeof(listened_ranges_ms) = 'array'),
  listened_ms integer NOT NULL CHECK (listened_ms BETWEEN 0 AND duration_ms),
  coverage numeric(7,6) NOT NULL CHECK (coverage BETWEEN 0 AND 1),
  completed boolean NOT NULL,
  natural_end_observed boolean NOT NULL,
  server_updated_at timestamptz NOT NULL,
  last_device_id text,
  source_kind text NOT NULL,
  source_reference text NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_learning_progress_history_lookup_idx
ON user_learning_progress_history (user_id, piece_id, archived_at DESC);

CREATE TABLE progress_sync_batches (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id text NOT NULL CHECK (batch_id ~ '^s02-batch-v1:[a-f0-9]{64}$'),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('processing', 'completed')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (user_id, batch_id),
  CHECK ((status = 'completed') = (response IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE progress_sync_operations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (operation_id ~ '^s02-op-v1:[a-f0-9]{64}$'),
  batch_id text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  piece_id text NOT NULL REFERENCES pieces(id) ON DELETE RESTRICT,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, operation_id),
  FOREIGN KEY (user_id, batch_id) REFERENCES progress_sync_batches(user_id, batch_id) ON DELETE CASCADE
);

CREATE INDEX progress_sync_operations_batch_idx
ON progress_sync_operations (user_id, batch_id);
