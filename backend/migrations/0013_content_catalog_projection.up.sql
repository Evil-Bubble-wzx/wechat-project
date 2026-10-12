ALTER TABLE content_versions
  ADD COLUMN catalog_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(catalog_metadata) = 'object');
ALTER TABLE processing_artifacts
  ADD COLUMN validation jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(validation) = 'object');
