ALTER TABLE works
  ADD COLUMN author text,
  ADD COLUMN series text,
  ADD COLUMN ranking_category text CHECK (ranking_category IS NULL OR ranking_category IN ('fiction', 'nonfiction'));

ALTER TABLE pieces
  ADD COLUMN word_count integer CHECK (word_count IS NULL OR word_count >= 0),
  ADD COLUMN ranking_level numeric(4,2) CHECK (ranking_level IS NULL OR ranking_level >= 0);

CREATE TABLE user_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campus_id text REFERENCES campuses(id) ON DELETE RESTRICT,
  grade text CHECK (grade IS NULL OR grade IN ('k', '1', '2', '3', '4', '5', '6', '7', '8', '9')),
  reading_level text CHECK (reading_level IS NULL OR reading_level IN ('1', '2', '3', '4', '5')),
  profile_source text NOT NULL CHECK (profile_source IN ('unverified', 'user', 'admin', 'school_sync')),
  source_verified_at timestamptz,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_until IS NULL OR effective_until > effective_from),
  CHECK (profile_source IN ('admin', 'school_sync') OR source_verified_at IS NULL),
  UNIQUE (user_id, effective_from)
);

CREATE UNIQUE INDEX user_profile_versions_current_uidx
ON user_profile_versions (user_id)
WHERE effective_until IS NULL;

CREATE INDEX user_profile_versions_lookup_idx
ON user_profile_versions (user_id, effective_from, effective_until);

INSERT INTO user_profile_versions (
  user_id, campus_id, grade, reading_level, profile_source,
  source_verified_at, effective_from
)
SELECT
  user_id, campus_id, grade, reading_level, profile_source,
  source_verified_at, created_at
FROM user_profiles;

CREATE FUNCTION record_user_profile_version() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed_at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'UPDATE' AND
     OLD.campus_id IS NOT DISTINCT FROM NEW.campus_id AND
     OLD.grade IS NOT DISTINCT FROM NEW.grade AND
     OLD.reading_level IS NOT DISTINCT FROM NEW.reading_level AND
     OLD.profile_source IS NOT DISTINCT FROM NEW.profile_source AND
     OLD.source_verified_at IS NOT DISTINCT FROM NEW.source_verified_at THEN
    RETURN NEW;
  END IF;

  UPDATE user_profile_versions
  SET effective_until = changed_at
  WHERE user_id = NEW.user_id AND effective_until IS NULL;

  INSERT INTO user_profile_versions (
    user_id, campus_id, grade, reading_level, profile_source,
    source_verified_at, effective_from
  ) VALUES (
    NEW.user_id, NEW.campus_id, NEW.grade, NEW.reading_level, NEW.profile_source,
    NEW.source_verified_at, changed_at
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_profiles_record_version
AFTER INSERT OR UPDATE ON user_profiles
FOR EACH ROW EXECUTE FUNCTION record_user_profile_version();

ALTER TABLE ranking_snapshots
  ADD COLUMN result_status text CHECK (result_status IS NULL OR result_status IN ('ready', 'cohort_too_small', 'unavailable')),
  ADD COLUMN cohort_size integer NOT NULL DEFAULT 0 CHECK (cohort_size >= 0),
  ADD COLUMN minimum_cohort_size integer NOT NULL DEFAULT 10 CHECK (minimum_cohort_size >= 1),
  ADD COLUMN algorithm_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(algorithm_metadata) = 'object'),
  ADD COLUMN source_max_verified_at timestamptz;

CREATE TABLE ranking_snapshot_entries (
  snapshot_id uuid NOT NULL REFERENCES ranking_snapshots(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  participant_id text NOT NULL CHECK (length(participant_id) BETWEEN 8 AND 128),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 64),
  rank integer NOT NULL CHECK (rank >= 1),
  score integer NOT NULL CHECK (score BETWEEN 0 AND 1000),
  completed_books integer NOT NULL CHECK (completed_books >= 1),
  total_words bigint NOT NULL CHECK (total_words >= 0),
  adjusted_accuracy numeric(5,2) NOT NULL CHECK (adjusted_accuracy BETWEEN 0 AND 100),
  score_breakdown jsonb NOT NULL CHECK (jsonb_typeof(score_breakdown) = 'array'),
  stats jsonb NOT NULL CHECK (jsonb_typeof(stats) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, user_id),
  UNIQUE (snapshot_id, participant_id)
);

CREATE INDEX ranking_snapshot_entries_page_idx
ON ranking_snapshot_entries (snapshot_id, rank, participant_id);

CREATE TABLE ranking_snapshot_quizzes (
  snapshot_id uuid NOT NULL,
  user_id uuid NOT NULL,
  quiz_attempt_id uuid NOT NULL REFERENCES quiz_attempts(id) ON DELETE RESTRICT,
  work_id text NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  piece_id text NOT NULL REFERENCES pieces(id) ON DELETE RESTRICT,
  title text NOT NULL,
  series text,
  author text,
  taken_at timestamptz NOT NULL,
  correct_percent numeric(5,2) NOT NULL CHECK (correct_percent BETWEEN 0 AND 100),
  level numeric(4,2) CHECK (level IS NULL OR level >= 0),
  category text CHECK (category IS NULL OR category IN ('fiction', 'nonfiction')),
  word_count integer NOT NULL CHECK (word_count >= 0),
  counted_in_score boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, quiz_attempt_id),
  FOREIGN KEY (snapshot_id, user_id)
    REFERENCES ranking_snapshot_entries(snapshot_id, user_id) ON DELETE CASCADE
);

CREATE INDEX ranking_snapshot_quizzes_page_idx
ON ranking_snapshot_quizzes (snapshot_id, user_id, taken_at DESC, quiz_attempt_id);
