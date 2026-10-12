DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM upload_sessions WHERE completion_intent_at IS NOT NULL OR storage_nonce IS NOT NULL)
     OR EXISTS (SELECT 1 FROM upload_session_mutations) THEN
    RAISE EXCEPTION 'upload recovery facts exist; export and resolve uploads before rollback';
  END IF;
END $$;
DROP TABLE upload_session_mutations;
ALTER TABLE upload_sessions
  DROP CONSTRAINT upload_completion_intent_check,
  DROP COLUMN storage_nonce,
  DROP COLUMN completion_request_hash,
  DROP COLUMN completion_parts,
  DROP COLUMN completion_intent_at;
