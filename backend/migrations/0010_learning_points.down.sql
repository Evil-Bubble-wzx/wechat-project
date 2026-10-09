-- Refuse a lossy downgrade; never clamp v2 points back to 1000.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ranking_snapshot_entries WHERE score>1000 OR completed_books=0) OR EXISTS (SELECT 1 FROM learning_score_events) THEN
    RAISE EXCEPTION 'Learning points exist; export and explicitly retire v2 data before rollback';
  END IF;
END; $$;
DROP TRIGGER quiz_answers_score ON quiz_answers;
DROP FUNCTION award_quiz_correct_answer();
DROP TRIGGER user_learning_progress_score ON user_learning_progress;
DROP FUNCTION award_learning_progress();
DROP TRIGGER learning_score_events_rebuild ON learning_score_events;
DROP FUNCTION queue_learning_score_rebuild();
ALTER TABLE ranking_rebuild_events DROP CONSTRAINT ranking_rebuild_events_source_check;
ALTER TABLE ranking_rebuild_events DROP COLUMN score_event_id, DROP COLUMN earned_at, DROP COLUMN user_id;
ALTER TABLE ranking_rebuild_events ALTER COLUMN quiz_attempt_id SET NOT NULL;
DROP VIEW valid_learning_score_events;
DROP TABLE learning_score_events;
DROP TABLE learning_score_state;
ALTER TABLE ranking_snapshot_entries DROP CONSTRAINT ranking_snapshot_entries_score_check;
ALTER TABLE ranking_snapshot_entries ALTER COLUMN score TYPE integer USING score::integer;
ALTER TABLE ranking_snapshot_entries ADD CONSTRAINT ranking_snapshot_entries_score_check CHECK (score BETWEEN 0 AND 1000);
ALTER TABLE ranking_snapshot_entries DROP CONSTRAINT ranking_snapshot_entries_completed_books_check;
ALTER TABLE ranking_snapshot_entries ADD CONSTRAINT ranking_snapshot_entries_completed_books_check CHECK (completed_books>=1);
