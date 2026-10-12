-- Durable intent survives object-storage success followed by a database failure.
ALTER TABLE upload_sessions
  ADD COLUMN storage_nonce uuid,
  ADD COLUMN completion_request_hash char(64) CHECK (completion_request_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN completion_parts jsonb CHECK (jsonb_typeof(completion_parts) = 'array'),
  ADD COLUMN completion_intent_at timestamptz,
  ADD CONSTRAINT upload_completion_intent_check CHECK (
    (completion_request_hash IS NULL AND completion_parts IS NULL AND completion_intent_at IS NULL)
    OR (completion_request_hash IS NOT NULL AND completion_parts IS NOT NULL AND completion_intent_at IS NOT NULL)
  );

CREATE TABLE upload_session_mutations (
  actor_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  upload_session_id uuid NOT NULL REFERENCES upload_sessions(id),
  action text NOT NULL CHECK (action IN ('renew', 'complete')),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, idempotency_key),
  CHECK ((action = 'renew') = (lease_expires_at IS NOT NULL))
);
