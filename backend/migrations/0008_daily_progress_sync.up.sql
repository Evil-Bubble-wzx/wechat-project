ALTER TABLE user_learning_progress
  DROP CONSTRAINT user_learning_progress_pkey;

ALTER TABLE user_learning_progress
  ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  ADD COLUMN server_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_mutation_id text,
  ADD COLUMN historical boolean NOT NULL DEFAULT false;

ALTER TABLE user_learning_progress
  ADD PRIMARY KEY (user_id, piece_id, content_version);

CREATE INDEX user_learning_progress_current_idx
ON user_learning_progress (user_id, piece_id, content_version, server_updated_at DESC);

CREATE TABLE progress_sync_mutations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mutation_id text NOT NULL CHECK (length(mutation_id) BETWEEN 8 AND 128),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, mutation_id),
  CHECK (expires_at > created_at)
);

CREATE INDEX progress_sync_mutations_expiry_idx
ON progress_sync_mutations (expires_at);
