DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ingestion_admin_mutations)
     OR EXISTS (SELECT 1 FROM processing_jobs WHERE dispatch_generation > 0)
     OR EXISTS (SELECT 1 FROM upload_sessions WHERE abort_confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'ingestion operations facts exist; resolve and preserve them before rollback';
  END IF;
END $$;
DROP INDEX ingestion_batches_created_id_idx;
DROP TABLE ingestion_admin_mutations;
ALTER TABLE upload_sessions DROP CONSTRAINT upload_abort_confirmation_check, DROP COLUMN abort_confirmed_at;
ALTER TABLE processing_jobs DROP COLUMN dispatch_generation;
