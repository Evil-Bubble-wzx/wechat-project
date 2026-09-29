CREATE SEQUENCE user_saved_words_change_seq AS bigint;

CREATE TABLE user_saved_words (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id text NOT NULL CHECK (entry_id ~ '^ve-[a-f0-9]{12,64}$'),
  piece_id text NOT NULL REFERENCES pieces(id) ON DELETE RESTRICT,
  content_version integer NOT NULL CHECK (content_version >= 1),
  vocab_key text NOT NULL CHECK (length(vocab_key) BETWEEN 1 AND 128),
  surface text NOT NULL CHECK (length(surface) BETWEEN 1 AND 80),
  lemma text NOT NULL CHECK (length(lemma) BETWEEN 1 AND 80),
  revision bigint NOT NULL CHECK (revision >= 1),
  deleted boolean NOT NULL DEFAULT false,
  server_updated_at timestamptz NOT NULL DEFAULT now(),
  last_device_id text,
  change_seq bigint NOT NULL DEFAULT nextval('user_saved_words_change_seq'),
  PRIMARY KEY (user_id, entry_id)
);

CREATE INDEX user_saved_words_user_change_idx
ON user_saved_words (user_id, change_seq);

CREATE TABLE user_saved_word_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id text NOT NULL,
  piece_id text NOT NULL REFERENCES pieces(id) ON DELETE RESTRICT,
  content_version integer NOT NULL CHECK (content_version >= 1),
  vocab_key text NOT NULL,
  surface text NOT NULL,
  lemma text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 1),
  deleted boolean NOT NULL,
  server_updated_at timestamptz NOT NULL,
  last_device_id text,
  source_reference text NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_saved_word_history_lookup_idx
ON user_saved_word_history (user_id, entry_id, archived_at DESC);

CREATE TABLE word_sync_batches (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id text NOT NULL CHECK (batch_id ~ '^s03-word-batch-v1:[a-f0-9]{64}$'),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('processing', 'completed')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (user_id, batch_id),
  CHECK ((status = 'completed') = (response IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE word_sync_operations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (operation_id ~ '^s03-word-op-v1:[a-f0-9]{64}$'),
  batch_id text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  entry_id text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, operation_id),
  FOREIGN KEY (user_id, batch_id) REFERENCES word_sync_batches(user_id, batch_id) ON DELETE CASCADE
);

CREATE INDEX word_sync_operations_batch_idx
ON word_sync_operations (user_id, batch_id);
