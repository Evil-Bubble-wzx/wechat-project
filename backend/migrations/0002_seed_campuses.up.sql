INSERT INTO campuses (id, display_name)
VALUES
  ('a', 'A校区'),
  ('b', 'B校区')
ON CONFLICT (id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    status = 'active';
