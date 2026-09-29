DROP TABLE IF EXISTS progress_sync_mutations;
DROP INDEX IF EXISTS user_learning_progress_current_idx;

DELETE FROM user_learning_progress older
USING user_learning_progress newer
WHERE older.user_id = newer.user_id
  AND older.piece_id = newer.piece_id
  AND (
    older.content_version < newer.content_version
    OR (older.content_version = newer.content_version AND older.server_updated_at < newer.server_updated_at)
  );

ALTER TABLE user_learning_progress
  DROP CONSTRAINT user_learning_progress_pkey;

ALTER TABLE user_learning_progress
  DROP COLUMN historical,
  DROP COLUMN last_mutation_id,
  DROP COLUMN server_updated_at,
  DROP COLUMN revision;

ALTER TABLE user_learning_progress
  ADD PRIMARY KEY (user_id, piece_id);
