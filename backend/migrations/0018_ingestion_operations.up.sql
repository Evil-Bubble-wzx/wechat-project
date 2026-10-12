ALTER TABLE processing_jobs ADD COLUMN dispatch_generation integer NOT NULL DEFAULT 0 CHECK (dispatch_generation >= 0);
ALTER TABLE upload_sessions ADD COLUMN abort_confirmed_at timestamptz,
  ADD CONSTRAINT upload_abort_confirmation_check CHECK (abort_confirmed_at IS NULL OR status = 'aborted');
CREATE TABLE ingestion_admin_mutations (
  actor_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  action text NOT NULL CHECK (action IN ('retry', 'cancel')),
  target_id uuid NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  dispatch_generation integer CHECK (dispatch_generation > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, idempotency_key),
  CHECK ((action = 'retry') = (dispatch_generation IS NOT NULL))
);
CREATE INDEX ingestion_batches_created_id_idx ON ingestion_batches (created_at DESC, id DESC);
