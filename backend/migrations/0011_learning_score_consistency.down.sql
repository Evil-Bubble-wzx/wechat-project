DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ranking_rebuild_events WHERE invalidated_score_event_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Score invalidation tasks exist; explicitly retire them before rollback';
  END IF;
END; $$;
DROP TRIGGER quiz_answers_score_restore ON quiz_answers;
DROP FUNCTION restore_quiz_learning_score();
DROP TRIGGER quiz_attempts_score_invalidation ON quiz_attempts;
DROP FUNCTION invalidate_quiz_learning_score();
ALTER TABLE ranking_rebuild_events DROP CONSTRAINT ranking_rebuild_events_source_check;
ALTER TABLE ranking_rebuild_events DROP COLUMN invalidated_score_event_id;
ALTER TABLE ranking_rebuild_events ADD CONSTRAINT ranking_rebuild_events_source_check
  CHECK (quiz_attempt_id IS NOT NULL OR score_event_id IS NOT NULL);
DROP TRIGGER learning_score_events_account_lock ON learning_score_events;
DROP FUNCTION lock_learning_score_account();
