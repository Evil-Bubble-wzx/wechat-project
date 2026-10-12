-- This removes derived analytics only, never Quiz answers, scores or learning events.
DROP INDEX ranking_snapshot_quizzes_verified_idx;
ALTER TABLE ranking_snapshot_quizzes DROP COLUMN quiz_points,DROP COLUMN word_count_known,DROP COLUMN content_version,DROP COLUMN verified_at,DROP COLUMN passed;
ALTER TABLE ranking_snapshot_entries DROP COLUMN quiz_analysis;
ALTER TABLE ranking_snapshots DROP COLUMN analysis_version;
