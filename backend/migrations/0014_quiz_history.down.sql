-- Remove only derived synchronization fields, never attempt/answer facts.
DROP TRIGGER quiz_attempts_history ON quiz_attempts;
DROP FUNCTION mark_quiz_history_change();
DROP INDEX quiz_attempts_history_idx;
ALTER TABLE quiz_attempts DROP COLUMN history_seq,DROP COLUMN history_updated_at;
DROP SEQUENCE quiz_history_change_seq;
