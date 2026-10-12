DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM content_import_groups) THEN
    RAISE EXCEPTION 'bulk content import facts exist; preserve them before rollback';
  END IF;
END $$;
DROP TABLE content_import_entries;
DROP TABLE content_import_groups;
