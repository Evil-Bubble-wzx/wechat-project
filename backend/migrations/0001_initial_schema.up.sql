CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  deleted_at timestamptz
);

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE wechat_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id text NOT NULL,
  openid_lookup_hash char(64) NOT NULL CHECK (openid_lookup_hash ~ '^[a-f0-9]{64}$'),
  openid_ciphertext bytea NOT NULL,
  unionid_lookup_hash char(64) CHECK (unionid_lookup_hash IS NULL OR unionid_lookup_hash ~ '^[a-f0-9]{64}$'),
  unionid_ciphertext bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, openid_lookup_hash),
  CHECK ((unionid_lookup_hash IS NULL) = (unionid_ciphertext IS NULL))
);

CREATE TRIGGER wechat_identities_set_updated_at
BEFORE UPDATE ON wechat_identities
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_family_id uuid NOT NULL,
  refresh_token_hash char(64) NOT NULL UNIQUE CHECK (refresh_token_hash ~ '^[a-f0-9]{64}$'),
  device_id text,
  expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  replaced_by_session_id uuid REFERENCES user_sessions(id),
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (replaced_by_session_id IS NULL OR rotated_at IS NOT NULL),
  CHECK (revoked_at IS NULL OR revoke_reason IS NOT NULL)
);

CREATE INDEX user_sessions_user_active_idx
ON user_sessions (user_id, expires_at)
WHERE revoked_at IS NULL;

CREATE TABLE campuses (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{0,31}$'),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER campuses_set_updated_at
BEFORE UPDATE ON campuses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  campus_id text REFERENCES campuses(id),
  grade text CHECK (grade IS NULL OR grade IN ('k', '1', '2', '3', '4', '5', '6', '7', '8', '9')),
  reading_level text CHECK (reading_level IS NULL OR reading_level IN ('1', '2', '3', '4', '5')),
  profile_source text NOT NULL DEFAULT 'unverified' CHECK (profile_source IN ('unverified', 'user', 'admin', 'school_sync')),
  source_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (profile_source IN ('admin', 'school_sync') OR source_verified_at IS NULL)
);

CREATE TRIGGER user_profiles_set_updated_at
BEFORE UPDATE ON user_profiles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE works (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text,
  access_type text NOT NULL DEFAULT 'free' CHECK (access_type IN ('free', 'restricted')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER works_set_updated_at
BEFORE UPDATE ON works
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE pieces (
  id text PRIMARY KEY,
  work_id text NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  title text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  access_type text NOT NULL DEFAULT 'free' CHECK (access_type IN ('free', 'restricted')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  current_content_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_id, sort_order)
);

CREATE TRIGGER pieces_set_updated_at
BEFORE UPDATE ON pieces
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE content_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  piece_id text NOT NULL REFERENCES pieces(id) ON DELETE RESTRICT,
  content_version integer NOT NULL CHECK (content_version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'processing', 'ready_for_review', 'rejected', 'published', 'superseded')),
  publishable boolean NOT NULL DEFAULT false,
  manifest_sha256 char(64) CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[a-f0-9]{64}$'),
  source_batch_id uuid,
  rollback_from_id uuid REFERENCES content_versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (piece_id, content_version),
  UNIQUE (piece_id, id),
  CHECK (status <> 'published' OR (publishable AND manifest_sha256 IS NOT NULL AND published_at IS NOT NULL))
);

CREATE TRIGGER content_versions_set_updated_at
BEFORE UPDATE ON content_versions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE pieces
ADD CONSTRAINT pieces_current_content_version_fk
FOREIGN KEY (id, current_content_version_id)
REFERENCES content_versions(piece_id, id)
DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE ingestion_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  source text NOT NULL,
  operator_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  work_id text NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  piece_id text NOT NULL REFERENCES pieces(id) ON DELETE RESTRICT,
  content_version integer NOT NULL CHECK (content_version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'uploading', 'queued', 'processing', 'partial_failed', 'ready_for_review', 'cancelled', 'published')),
  total_count integer NOT NULL CHECK (total_count >= 1),
  succeeded_count integer NOT NULL DEFAULT 0 CHECK (succeeded_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  cancelled_at timestamptz,
  CHECK (succeeded_count + failed_count <= total_count)
);

CREATE UNIQUE INDEX ingestion_batches_active_piece_version_uidx
ON ingestion_batches (piece_id, content_version)
WHERE status IN ('draft', 'uploading', 'queued', 'processing', 'partial_failed', 'ready_for_review');

CREATE TRIGGER ingestion_batches_set_updated_at
BEFORE UPDATE ON ingestion_batches
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE content_versions
ADD CONSTRAINT content_versions_source_batch_fk
FOREIGN KEY (source_batch_id) REFERENCES ingestion_batches(id) ON DELETE SET NULL;

CREATE TABLE ingestion_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES ingestion_batches(id) ON DELETE CASCADE,
  client_file_id text NOT NULL,
  asset_type text NOT NULL CHECK (asset_type IN ('audio', 'subtitles', 'text', 'vocabulary', 'quiz', 'cover', 'metadata')),
  file_name text NOT NULL,
  expected_size_bytes bigint NOT NULL CHECK (expected_size_bytes > 0),
  expected_sha256 char(64) NOT NULL CHECK (expected_sha256 ~ '^[a-f0-9]{64}$'),
  mime_type text NOT NULL,
  status text NOT NULL DEFAULT 'declared' CHECK (status IN ('declared', 'uploading', 'uploaded', 'queued', 'processing', 'ready', 'failed', 'cancelled')),
  error_code text,
  error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, client_file_id),
  CHECK ((status = 'failed') = (error_code IS NOT NULL))
);

CREATE TRIGGER ingestion_items_set_updated_at
BEFORE UPDATE ON ingestion_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingestion_item_id uuid NOT NULL REFERENCES ingestion_items(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  bucket text NOT NULL,
  object_key text NOT NULL,
  multipart_upload_id text NOT NULL,
  part_size_bytes integer NOT NULL CHECK (part_size_bytes >= 5242880),
  expected_size_bytes bigint NOT NULL CHECK (expected_size_bytes > 0),
  expected_sha256 char(64) NOT NULL CHECK (expected_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired', 'aborted')),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, object_key, multipart_upload_id),
  CHECK (expires_at > created_at),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX upload_sessions_expiry_idx
ON upload_sessions (expires_at)
WHERE status = 'active';

CREATE TABLE processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingestion_item_id uuid NOT NULL REFERENCES ingestion_items(id) ON DELETE CASCADE,
  job_type text NOT NULL CHECK (job_type IN ('checksum', 'media_probe', 'transcode', 'subtitle_parse', 'subtitle_align', 'package_validate', 'manifest_build')),
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'dead_letter', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  next_retry_at timestamptz,
  worker_id text,
  error_code text,
  error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_type, idempotency_key),
  CHECK (attempt_count <= max_attempts),
  CHECK (status NOT IN ('failed', 'dead_letter') OR error_code IS NOT NULL)
);

CREATE INDEX processing_jobs_dispatch_idx
ON processing_jobs (status, next_retry_at, created_at)
WHERE status IN ('queued', 'retry_wait');

CREATE TRIGGER processing_jobs_set_updated_at
BEFORE UPDATE ON processing_jobs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE processing_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  processing_job_id uuid NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
  parent_artifact_id uuid REFERENCES processing_artifacts(id) ON DELETE RESTRICT,
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('original', 'intermediate', 'ready', 'published', 'quarantine')),
  bucket text NOT NULL,
  object_key text NOT NULL,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  mime_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, object_key)
);

CREATE TABLE content_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  piece_id text NOT NULL,
  content_version integer NOT NULL CHECK (content_version >= 1),
  asset_type text NOT NULL CHECK (asset_type IN ('audio', 'subtitles', 'text', 'vocabulary', 'quiz', 'cover', 'metadata')),
  source_artifact_id uuid REFERENCES processing_artifacts(id) ON DELETE SET NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  mime_type text NOT NULL,
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'published', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (piece_id, content_version) REFERENCES content_versions(piece_id, content_version) ON DELETE RESTRICT,
  UNIQUE (piece_id, content_version, asset_type),
  UNIQUE (bucket, object_key)
);

CREATE INDEX content_assets_sha256_idx ON content_assets (sha256);

CREATE TABLE content_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_version_id uuid NOT NULL REFERENCES content_versions(id) ON DELETE CASCADE,
  gate_key text NOT NULL,
  reviewer_actor_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('pending', 'approved', 'rejected')),
  evidence_reference text,
  notes text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((decision = 'pending') = (reviewed_at IS NULL))
);

CREATE INDEX content_reviews_version_gate_idx
ON content_reviews (content_version_id, gate_key, created_at DESC);

CREATE TABLE quiz_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  piece_id text NOT NULL,
  content_version integer NOT NULL CHECK (content_version >= 1),
  quiz_version integer NOT NULL CHECK (quiz_version >= 1),
  package_sha256 char(64) NOT NULL CHECK (package_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  mastery_threshold integer NOT NULL CHECK (mastery_threshold BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  FOREIGN KEY (piece_id, content_version) REFERENCES content_versions(piece_id, content_version) ON DELETE RESTRICT,
  UNIQUE (piece_id, content_version, quiz_version),
  CHECK (status <> 'published' OR published_at IS NOT NULL)
);

CREATE TABLE quiz_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_package_id uuid NOT NULL REFERENCES quiz_packages(id) ON DELETE CASCADE,
  question_id text NOT NULL,
  prompt text NOT NULL,
  options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) >= 2),
  correct_option integer NOT NULL CHECK (correct_option >= 0),
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quiz_package_id, question_id),
  UNIQUE (quiz_package_id, sort_order),
  CHECK (correct_option < jsonb_array_length(options))
);

CREATE TABLE quiz_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attempt_id text NOT NULL,
  quiz_package_id uuid NOT NULL REFERENCES quiz_packages(id) ON DELETE RESTRICT,
  started_at timestamptz NOT NULL,
  submitted_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('server_verified', 'rejected')),
  score integer CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  mastery boolean,
  rejection_code text,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, attempt_id),
  CHECK (submitted_at >= started_at),
  CHECK (
    (status = 'server_verified' AND score IS NOT NULL AND mastery IS NOT NULL AND rejection_code IS NULL AND verified_at IS NOT NULL)
    OR
    (status = 'rejected' AND score IS NULL AND mastery IS NULL AND rejection_code IS NOT NULL)
  )
);

CREATE TABLE quiz_answers (
  quiz_attempt_id uuid NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  quiz_question_id uuid NOT NULL REFERENCES quiz_questions(id) ON DELETE RESTRICT,
  selected_option integer NOT NULL CHECK (selected_option >= 0),
  is_correct boolean NOT NULL,
  PRIMARY KEY (quiz_attempt_id, quiz_question_id)
);

CREATE TABLE ranking_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_type text NOT NULL CHECK (period_type IN ('rolling7', 'week', 'month', 'year')),
  period_key text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  campus_id text NOT NULL REFERENCES campuses(id) ON DELETE RESTRICT,
  grade text CHECK (grade IS NULL OR grade IN ('k', '1', '2', '3', '4', '5', '6', '7', '8', '9')),
  reading_level text CHECK (reading_level IS NULL OR reading_level IN ('1', '2', '3', '4', '5')),
  rule_version text NOT NULL,
  status text NOT NULL DEFAULT 'building' CHECK (status IN ('building', 'ready', 'failed', 'superseded')),
  entries jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(entries) = 'array'),
  generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (status <> 'ready' OR generated_at IS NOT NULL)
);

CREATE UNIQUE INDEX ranking_snapshots_dimensions_uidx
ON ranking_snapshots (period_type, period_key, campus_id, grade, reading_level, rule_version) NULLS NOT DISTINCT;

CREATE INDEX ranking_snapshots_lookup_idx
ON ranking_snapshots (campus_id, period_type, period_key, status, generated_at DESC);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'admin', 'service', 'worker')),
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  request_id text NOT NULL,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_target_idx ON audit_events (target_type, target_id, occurred_at DESC);
CREATE INDEX audit_events_request_idx ON audit_events (request_id);

CREATE FUNCTION prevent_audit_event_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$;

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();
