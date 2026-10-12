CREATE SEQUENCE reader_library_change_seq AS bigint;

CREATE TABLE reader_library_entries (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id text NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  favorite boolean NOT NULL DEFAULT false,
  favorite_revision bigint NOT NULL DEFAULT 0 CHECK (favorite_revision >= 0),
  last_opened_at timestamptz,
  server_updated_at timestamptz NOT NULL DEFAULT now(),
  change_seq bigint NOT NULL DEFAULT nextval('reader_library_change_seq'),
  PRIMARY KEY (user_id, work_id)
);
CREATE INDEX reader_library_user_change_idx ON reader_library_entries(user_id, change_seq);

CREATE TABLE reader_library_batches (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id text NOT NULL CHECK (length(batch_id) BETWEEN 8 AND 128),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, batch_id)
);
CREATE TABLE reader_library_operations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (operation_id ~ '^library-op-v1:[a-f0-9]{64}$'),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, operation_id)
);
