-- No profile, profile version, learning fact or audit record is removed.
-- Re-up generates different lookup codes, so old code-bound mutations cannot overwrite a new revision 0.
DROP TRIGGER user_profiles_revision ON user_profiles;
DROP FUNCTION increment_student_profile_revision();
ALTER TABLE user_profiles DROP COLUMN revision;
DROP INDEX users_student_code_uidx;
ALTER TABLE users DROP COLUMN student_code;
