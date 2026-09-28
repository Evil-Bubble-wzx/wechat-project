CREATE TABLE local_import_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snapshot_id text NOT NULL CHECK (snapshot_id ~ '^s01-v1:[a-f0-9]{64}$'),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('processing', 'completed')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (user_id, snapshot_id),
  CHECK ((status = 'completed') = (response IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE user_learning_progress (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  piece_id text NOT NULL REFERENCES pieces(id) ON DELETE RESTRICT,
  content_version integer NOT NULL CHECK (content_version >= 1),
  duration_ms integer NOT NULL CHECK (duration_ms > 0),
  checkpoint_ms integer NOT NULL CHECK (checkpoint_ms BETWEEN 0 AND duration_ms),
  listened_ranges_ms jsonb NOT NULL CHECK (jsonb_typeof(listened_ranges_ms) = 'array'),
  listened_ms integer NOT NULL CHECK (listened_ms BETWEEN 0 AND duration_ms),
  coverage numeric(7,6) NOT NULL CHECK (coverage BETWEEN 0 AND 1),
  completed boolean NOT NULL,
  source_updated_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  source_snapshot_id text NOT NULL,
  PRIMARY KEY (user_id, piece_id)
);

CREATE TABLE user_saved_word_candidates (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  surface text NOT NULL CHECK (length(surface) BETWEEN 1 AND 80),
  resolution_status text NOT NULL DEFAULT 'pending' CHECK (resolution_status IN ('pending', 'resolved', 'rejected')),
  first_snapshot_id text NOT NULL,
  last_snapshot_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, surface)
);

CREATE TRIGGER user_saved_word_candidates_set_updated_at
BEFORE UPDATE ON user_saved_word_candidates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
