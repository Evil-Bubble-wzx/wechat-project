DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM reader_library_entries)
     OR EXISTS (SELECT 1 FROM reader_library_batches)
     OR EXISTS (SELECT 1 FROM reader_library_operations) THEN
    RAISE EXCEPTION 'Cannot roll back reader library with retained account data; export and migrate it first';
  END IF;
END;
$$;
DROP TABLE reader_library_operations;
DROP TABLE reader_library_batches;
DROP TABLE reader_library_entries;
DROP SEQUENCE reader_library_change_seq;
