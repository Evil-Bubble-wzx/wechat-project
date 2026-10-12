-- Immutable enrichment; old snapshots retain their original data and identity.
ALTER TABLE ranking_snapshots ADD COLUMN analysis_version smallint NOT NULL DEFAULT 0 CHECK (analysis_version IN (0,1));
ALTER TABLE ranking_snapshot_entries ADD COLUMN quiz_analysis jsonb CHECK (quiz_analysis IS NULL OR jsonb_typeof(quiz_analysis)='object');
ALTER TABLE ranking_snapshot_quizzes
  ADD COLUMN passed boolean,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN content_version integer CHECK (content_version IS NULL OR content_version>=1),
  ADD COLUMN word_count_known boolean,
  ADD COLUMN quiz_points numeric(40,0) CHECK (quiz_points IS NULL OR quiz_points>=0);
CREATE INDEX ranking_snapshot_quizzes_verified_idx ON ranking_snapshot_quizzes(snapshot_id,user_id,verified_at DESC,quiz_attempt_id);
