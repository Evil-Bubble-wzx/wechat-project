-- Lookup codes and revisions are derived; profile facts and version history stay authoritative.
ALTER TABLE users ADD COLUMN student_code text NOT NULL
  DEFAULT ('student_' || replace(gen_random_uuid()::text, '-', ''))
  CHECK (student_code ~ '^student_[a-f0-9]{32}$');
CREATE UNIQUE INDEX users_student_code_uidx ON users(student_code);
ALTER TABLE user_profiles ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0);
CREATE FUNCTION increment_student_profile_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN NEW.revision:=1;
  ELSIF OLD.campus_id IS DISTINCT FROM NEW.campus_id OR OLD.grade IS DISTINCT FROM NEW.grade
    OR OLD.reading_level IS DISTINCT FROM NEW.reading_level OR OLD.profile_source IS DISTINCT FROM NEW.profile_source
    OR OLD.source_verified_at IS DISTINCT FROM NEW.source_verified_at THEN NEW.revision:=OLD.revision+1;
  ELSE NEW.revision:=OLD.revision;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER user_profiles_revision BEFORE INSERT OR UPDATE ON user_profiles
FOR EACH ROW EXECUTE FUNCTION increment_student_profile_revision();
