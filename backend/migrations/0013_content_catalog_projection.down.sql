DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content_versions WHERE catalog_metadata <> '{}'::jsonb)
     OR EXISTS (SELECT 1 FROM processing_artifacts WHERE validation <> '{}'::jsonb) THEN
    RAISE EXCEPTION 'Cannot roll back content catalog while validated metadata exists';
  END IF;
END $$;
ALTER TABLE processing_artifacts DROP COLUMN validation;
ALTER TABLE content_versions DROP COLUMN catalog_metadata;
