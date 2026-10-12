-- Derived change tracking; attempt facts and answers remain authoritative.
CREATE SEQUENCE quiz_history_change_seq AS bigint;
ALTER TABLE quiz_attempts ADD COLUMN history_seq bigint;
ALTER TABLE quiz_attempts ADD COLUMN history_updated_at timestamptz;
UPDATE quiz_attempts SET history_seq=nextval('quiz_history_change_seq'),history_updated_at=COALESCE(verified_at,created_at);
ALTER TABLE quiz_attempts ALTER COLUMN history_seq SET NOT NULL;
ALTER TABLE quiz_attempts ALTER COLUMN history_updated_at SET NOT NULL;
CREATE INDEX quiz_attempts_history_idx ON quiz_attempts(user_id,history_seq);
CREATE FUNCTION mark_quiz_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Allocate only after the account lock: sequence order must follow commits.
  PERFORM id FROM users WHERE id=NEW.user_id FOR NO KEY UPDATE;
  IF TG_OP='INSERT' THEN
    NEW.history_seq:=nextval('quiz_history_change_seq');
    NEW.history_updated_at:=clock_timestamp();
  ELSIF ROW(NEW.status,NEW.score,NEW.mastery,NEW.withdrawn_at,NEW.rejection_code,NEW.verified_at,NEW.quiz_package_id,NEW.started_at,NEW.submitted_at)
    IS DISTINCT FROM ROW(OLD.status,OLD.score,OLD.mastery,OLD.withdrawn_at,OLD.rejection_code,OLD.verified_at,OLD.quiz_package_id,OLD.started_at,OLD.submitted_at) THEN
    NEW.history_seq:=nextval('quiz_history_change_seq');
    NEW.history_updated_at:=clock_timestamp();
  ELSE
    NEW.history_seq:=OLD.history_seq;
    NEW.history_updated_at:=OLD.history_updated_at;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER quiz_attempts_history BEFORE INSERT OR UPDATE ON quiz_attempts FOR EACH ROW EXECUTE FUNCTION mark_quiz_history_change();
