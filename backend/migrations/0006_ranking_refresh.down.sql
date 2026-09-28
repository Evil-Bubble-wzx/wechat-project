DROP TRIGGER IF EXISTS user_profiles_audit_change ON user_profiles;
DROP FUNCTION IF EXISTS audit_user_profile_change();

DROP TABLE IF EXISTS ranking_rebuild_events;

ALTER TABLE ranking_snapshot_entries
  DROP COLUMN IF EXISTS profile_reading_level,
  DROP COLUMN IF EXISTS profile_grade;

DROP INDEX IF EXISTS ranking_snapshots_source_uidx;

DELETE FROM ranking_snapshots newer
USING ranking_snapshots older
WHERE newer.id <> older.id
  AND newer.period_type = older.period_type
  AND newer.period_key = older.period_key
  AND newer.campus_id = older.campus_id
  AND newer.grade IS NOT DISTINCT FROM older.grade
  AND newer.reading_level IS NOT DISTINCT FROM older.reading_level
  AND newer.rule_version = older.rule_version
  AND (newer.generated_at, newer.created_at, newer.id) < (older.generated_at, older.created_at, older.id);

ALTER TABLE ranking_snapshots DROP COLUMN IF EXISTS source_fingerprint;

CREATE UNIQUE INDEX ranking_snapshots_dimensions_uidx
ON ranking_snapshots (period_type, period_key, campus_id, grade, reading_level, rule_version) NULLS NOT DISTINCT;

ALTER TABLE quiz_attempts
  DROP CONSTRAINT IF EXISTS quiz_attempts_withdrawal_check,
  DROP COLUMN IF EXISTS withdrawal_reason,
  DROP COLUMN IF EXISTS withdrawn_at;
