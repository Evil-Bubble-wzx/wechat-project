ALTER TABLE quiz_attempts
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN withdrawal_reason text,
  ADD CONSTRAINT quiz_attempts_withdrawal_check CHECK (
    (withdrawn_at IS NULL AND withdrawal_reason IS NULL)
    OR
    (withdrawn_at IS NOT NULL AND withdrawal_reason IS NOT NULL AND length(withdrawal_reason) BETWEEN 1 AND 256)
  );

ALTER TABLE ranking_snapshots
  ADD COLUMN source_fingerprint char(64)
    CHECK (source_fingerprint IS NULL OR source_fingerprint ~ '^[a-f0-9]{64}$');

DROP INDEX ranking_snapshots_dimensions_uidx;

CREATE UNIQUE INDEX ranking_snapshots_source_uidx
ON ranking_snapshots (
  period_type, period_key, campus_id, grade, reading_level,
  rule_version, source_fingerprint
) NULLS NOT DISTINCT
WHERE source_fingerprint IS NOT NULL;

ALTER TABLE ranking_snapshot_entries
  ADD COLUMN profile_grade text
    CHECK (profile_grade IS NULL OR profile_grade IN ('k', '1', '2', '3', '4', '5', '6', '7', '8', '9')),
  ADD COLUMN profile_reading_level text
    CHECK (profile_reading_level IS NULL OR profile_reading_level IN ('1', '2', '3', '4', '5'));

CREATE TABLE ranking_rebuild_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_attempt_id uuid NOT NULL UNIQUE REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ranking_rebuild_events_claim_idx
ON ranking_rebuild_events (status, available_at, created_at)
WHERE status IN ('pending', 'failed');

CREATE FUNCTION audit_user_profile_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  request_context text := COALESCE(NULLIF(current_setting('app.request_id', true), ''), 'database-trigger');
  actor_context text := COALESCE(NULLIF(current_setting('app.actor_id', true), ''), 'profile-version-trigger');
BEGIN
  INSERT INTO audit_events (
    actor_type, actor_id, action, target_type, target_id, request_id,
    before_state, after_state, metadata
  ) VALUES (
    'service', actor_context, 'user_profile_changed', 'user_profile', NEW.user_id::text,
    request_context,
    CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object(
      'campusId', OLD.campus_id,
      'grade', OLD.grade,
      'readingLevel', OLD.reading_level,
      'profileSource', OLD.profile_source
    ) ELSE NULL END,
    jsonb_build_object(
      'campusId', NEW.campus_id,
      'grade', NEW.grade,
      'readingLevel', NEW.reading_level,
      'profileSource', NEW.profile_source
    ),
    jsonb_build_object('operation', lower(TG_OP))
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_profiles_audit_change
AFTER INSERT OR UPDATE ON user_profiles
FOR EACH ROW EXECUTE FUNCTION audit_user_profile_change();
