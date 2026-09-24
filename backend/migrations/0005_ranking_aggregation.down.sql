DROP TABLE IF EXISTS ranking_snapshot_quizzes;
DROP TABLE IF EXISTS ranking_snapshot_entries;

ALTER TABLE ranking_snapshots
  DROP COLUMN IF EXISTS source_max_verified_at,
  DROP COLUMN IF EXISTS algorithm_metadata,
  DROP COLUMN IF EXISTS minimum_cohort_size,
  DROP COLUMN IF EXISTS cohort_size,
  DROP COLUMN IF EXISTS result_status;

DROP TRIGGER IF EXISTS user_profiles_record_version ON user_profiles;
DROP FUNCTION IF EXISTS record_user_profile_version();
DROP TABLE IF EXISTS user_profile_versions;

ALTER TABLE pieces
  DROP COLUMN IF EXISTS ranking_level,
  DROP COLUMN IF EXISTS word_count;

ALTER TABLE works
  DROP COLUMN IF EXISTS ranking_category,
  DROP COLUMN IF EXISTS series,
  DROP COLUMN IF EXISTS author;
