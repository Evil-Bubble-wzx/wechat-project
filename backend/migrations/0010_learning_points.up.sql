-- Preserve v1 snapshots. NUMERIC has no application-level points ceiling.
ALTER TABLE ranking_snapshot_entries DROP CONSTRAINT ranking_snapshot_entries_score_check;
ALTER TABLE ranking_snapshot_entries ALTER COLUMN score TYPE numeric USING score::numeric;
ALTER TABLE ranking_snapshot_entries ADD CONSTRAINT ranking_snapshot_entries_score_check CHECK (score>=0 AND score=trunc(score));
ALTER TABLE ranking_snapshot_entries DROP CONSTRAINT ranking_snapshot_entries_completed_books_check;
ALTER TABLE ranking_snapshot_entries ADD CONSTRAINT ranking_snapshot_entries_completed_books_check CHECK (completed_books>=0);
CREATE TABLE learning_score_state (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  piece_id text NOT NULL REFERENCES pieces(id) ON DELETE RESTRICT,
  credited_seconds bigint NOT NULL DEFAULT 0 CHECK (credited_seconds>=0),
  completion_awarded boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id,piece_id)
);
CREATE TABLE learning_score_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  piece_id text NOT NULL REFERENCES pieces(id) ON DELETE RESTRICT,
  event_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('listening','completion','quizCorrect')),
  points numeric NOT NULL CHECK (points>0 AND points=trunc(points)),
  earned_at timestamptz NOT NULL,
  quiz_attempt_id uuid REFERENCES quiz_attempts(id) ON DELETE RESTRICT,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  rule_version text NOT NULL DEFAULT 'learning-points-v2' CHECK (rule_version='learning-points-v2'),
  UNIQUE (user_id,event_key),
  CHECK (kind<>'quizCorrect' OR (quiz_attempt_id IS NOT NULL AND details ? 'questionId'))
);
CREATE INDEX learning_score_events_period_idx ON learning_score_events (earned_at,user_id);
CREATE INDEX learning_score_events_user_idx ON learning_score_events (user_id,earned_at);
CREATE VIEW valid_learning_score_events AS
SELECT event.* FROM learning_score_events event
WHERE event.kind<>'quizCorrect' OR EXISTS (
  SELECT 1 FROM quiz_answers answer JOIN quiz_attempts attempt ON attempt.id=answer.quiz_attempt_id
  JOIN quiz_questions question ON question.id=answer.quiz_question_id
  JOIN quiz_packages package ON package.id=question.quiz_package_id
  WHERE attempt.user_id=event.user_id AND package.piece_id=event.piece_id
    AND question.question_id=event.details->>'questionId'
    AND answer.is_correct AND attempt.status='server_verified' AND attempt.withdrawn_at IS NULL
);
ALTER TABLE ranking_rebuild_events ALTER COLUMN quiz_attempt_id DROP NOT NULL;
ALTER TABLE ranking_rebuild_events ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ranking_rebuild_events ADD COLUMN earned_at timestamptz;
ALTER TABLE ranking_rebuild_events ADD COLUMN score_event_id uuid UNIQUE REFERENCES learning_score_events(id) ON DELETE CASCADE;
ALTER TABLE ranking_rebuild_events ADD CONSTRAINT ranking_rebuild_events_source_check CHECK (quiz_attempt_id IS NOT NULL OR score_event_id IS NOT NULL);
CREATE FUNCTION queue_learning_score_rebuild() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ranking_rebuild_events (score_event_id,user_id,earned_at)
  VALUES (NEW.id,NEW.user_id,NEW.earned_at) ON CONFLICT (score_event_id) DO NOTHING;
  RETURN NEW;
END; $$;
CREATE TRIGGER learning_score_events_rebuild AFTER INSERT ON learning_score_events FOR EACH ROW EXECUTE FUNCTION queue_learning_score_rebuild();
CREATE FUNCTION award_learning_progress() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_seconds bigint; previous_completion boolean; seconds_now bigint; delta bigint;
BEGIN
  INSERT INTO learning_score_state (user_id,piece_id) VALUES (NEW.user_id,NEW.piece_id) ON CONFLICT DO NOTHING;
  SELECT credited_seconds,completion_awarded INTO previous_seconds,previous_completion
  FROM learning_score_state WHERE user_id=NEW.user_id AND piece_id=NEW.piece_id FOR UPDATE;
  seconds_now:=floor(NEW.listened_ms::numeric/1000)::bigint;
  delta:=GREATEST(0,seconds_now-previous_seconds);
  IF delta>0 THEN
    INSERT INTO learning_score_events (user_id,piece_id,event_key,kind,points,earned_at,details)
    VALUES (NEW.user_id,NEW.piece_id,'listen:'||NEW.piece_id||':'||seconds_now,'listening',delta,NEW.server_updated_at,
      jsonb_build_object('contentVersion',NEW.content_version,'fromSeconds',previous_seconds,'toSeconds',seconds_now));
  END IF;
  IF NEW.completed AND NOT previous_completion THEN
    INSERT INTO learning_score_events (user_id,piece_id,event_key,kind,points,earned_at,details)
    VALUES (NEW.user_id,NEW.piece_id,'complete:'||NEW.piece_id,'completion',50,NEW.server_updated_at,
      jsonb_build_object('contentVersion',NEW.content_version));
  END IF;
  UPDATE learning_score_state SET credited_seconds=GREATEST(previous_seconds,seconds_now),completion_awarded=previous_completion OR NEW.completed
  WHERE user_id=NEW.user_id AND piece_id=NEW.piece_id;
  RETURN NEW;
END; $$;
CREATE TRIGGER user_learning_progress_score AFTER INSERT OR UPDATE ON user_learning_progress FOR EACH ROW EXECUTE FUNCTION award_learning_progress();
CREATE FUNCTION award_quiz_correct_answer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fact record;
BEGIN
  IF NOT NEW.is_correct THEN RETURN NEW; END IF;
  SELECT attempt.user_id,attempt.id AS attempt_id,attempt.verified_at,package.piece_id,question.question_id INTO fact
  FROM quiz_attempts attempt JOIN quiz_questions question ON question.id=NEW.quiz_question_id
  JOIN quiz_packages package ON package.id=question.quiz_package_id
  WHERE attempt.id=NEW.quiz_attempt_id AND attempt.status='server_verified' AND attempt.withdrawn_at IS NULL;
  IF FOUND THEN
    INSERT INTO learning_score_events (user_id,piece_id,event_key,kind,points,earned_at,quiz_attempt_id,details)
    VALUES (fact.user_id,fact.piece_id,'question:'||fact.piece_id||':'||fact.question_id,'quizCorrect',10,fact.verified_at,
      fact.attempt_id,jsonb_build_object('questionId',fact.question_id)) ON CONFLICT (user_id,event_key) DO NOTHING;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER quiz_answers_score AFTER INSERT ON quiz_answers FOR EACH ROW EXECUTE FUNCTION award_quiz_correct_answer();
-- Known historical timestamps only; a stored total cannot reconstruct the
-- missing per-second history. No historical v1 snapshot is rewritten.
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT user_id,piece_id,content_version FROM user_learning_progress ORDER BY server_updated_at LOOP
    UPDATE user_learning_progress SET listened_ms=listened_ms WHERE user_id=item.user_id AND piece_id=item.piece_id AND content_version=item.content_version;
  END LOOP;
END; $$;
INSERT INTO learning_score_events (user_id,piece_id,event_key,kind,points,earned_at,quiz_attempt_id,details)
SELECT DISTINCT ON (attempt.user_id,package.piece_id,question.question_id)
  attempt.user_id,package.piece_id,'question:'||package.piece_id||':'||question.question_id,'quizCorrect',10,
  attempt.verified_at,attempt.id,jsonb_build_object('questionId',question.question_id)
FROM quiz_answers answer JOIN quiz_attempts attempt ON attempt.id=answer.quiz_attempt_id
JOIN quiz_questions question ON question.id=answer.quiz_question_id JOIN quiz_packages package ON package.id=question.quiz_package_id
WHERE answer.is_correct AND attempt.status='server_verified' AND attempt.withdrawn_at IS NULL
ORDER BY attempt.user_id,package.piece_id,question.question_id,attempt.verified_at,attempt.id ON CONFLICT (user_id,event_key) DO NOTHING;
