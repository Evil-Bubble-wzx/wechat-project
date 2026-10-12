-- Preserve historical-import exclusion across the two integrated score implementations.
CREATE OR REPLACE FUNCTION invalidate_quiz_learning_score() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status AND OLD.withdrawn_at IS NOT DISTINCT FROM NEW.withdrawn_at THEN
    RETURN NEW;
  END IF;
  PERFORM id FROM users WHERE id=NEW.user_id FOR NO KEY UPDATE;
  INSERT INTO ranking_rebuild_events (user_id,earned_at,invalidated_score_event_id)
  SELECT event.user_id,event.earned_at,event.id
  FROM learning_score_events event
  WHERE event.user_id=NEW.user_id AND event.kind='quizCorrect' AND NOT event.historical
    AND EXISTS (
      SELECT 1 FROM quiz_answers answer
      JOIN quiz_questions question ON question.id=answer.quiz_question_id
      JOIN quiz_packages package ON package.id=question.quiz_package_id
      WHERE answer.quiz_attempt_id=NEW.id AND answer.is_correct
        AND package.piece_id=event.piece_id AND question.question_id=event.details->>'questionId'
    );
  RETURN NEW;
END; $$;


CREATE OR REPLACE FUNCTION restore_quiz_learning_score() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.is_correct THEN RETURN NEW; END IF;
  INSERT INTO ranking_rebuild_events (user_id,earned_at,invalidated_score_event_id)
  SELECT event.user_id,event.earned_at,event.id
  FROM quiz_attempts attempt
  JOIN quiz_questions question ON question.id=NEW.quiz_question_id
  JOIN quiz_packages package ON package.id=question.quiz_package_id
  JOIN learning_score_events event ON event.user_id=attempt.user_id AND event.piece_id=package.piece_id
    AND event.kind='quizCorrect' AND NOT event.historical AND event.details->>'questionId'=question.question_id
  WHERE attempt.id=NEW.quiz_attempt_id AND attempt.status='server_verified' AND attempt.withdrawn_at IS NULL
    AND event.quiz_attempt_id<>NEW.quiz_attempt_id
    AND NOT EXISTS (
      SELECT 1 FROM quiz_answers other_answer
      JOIN quiz_attempts other_attempt ON other_attempt.id=other_answer.quiz_attempt_id
      JOIN quiz_questions other_question ON other_question.id=other_answer.quiz_question_id
      JOIN quiz_packages other_package ON other_package.id=other_question.quiz_package_id
      WHERE other_attempt.id<>NEW.quiz_attempt_id AND other_attempt.user_id=event.user_id
        AND other_attempt.status='server_verified' AND other_attempt.withdrawn_at IS NULL
        AND other_answer.is_correct AND other_package.piece_id=event.piece_id
        AND other_question.question_id=question.question_id
    );
  RETURN NEW;
END; $$;
