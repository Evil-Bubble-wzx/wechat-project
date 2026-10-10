CREATE TABLE content_bundles (
  id text NOT NULL,
  version integer NOT NULL CHECK(version>0),
  title text NOT NULL,
  price_fen integer NOT NULL CHECK(price_fen>0),
  currency text NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),
  mode text NOT NULL DEFAULT 'simulation' CHECK(mode='simulation'),
  contents jsonb NOT NULL CHECK(jsonb_typeof(contents)='array' AND jsonb_array_length(contents)>0),
  PRIMARY KEY(id,version)
);
CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  bundle_id text NOT NULL,
  bundle_version integer NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','refunded')),
  title text NOT NULL,
  amount_fen integer NOT NULL CHECK(amount_fen>0),
  currency text NOT NULL CHECK(currency='CNY'),
  contents jsonb NOT NULL CHECK(jsonb_typeof(contents)='array'),
  mode text NOT NULL DEFAULT 'simulation' CHECK(mode='simulation'),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  refunded_at timestamptz,
  FOREIGN KEY(bundle_id,bundle_version) REFERENCES content_bundles(id,version),
  UNIQUE(user_id,idempotency_key),
  CHECK((status='pending' AND paid_at IS NULL AND refunded_at IS NULL) OR
        (status='paid' AND paid_at IS NOT NULL AND refunded_at IS NULL) OR
        (status='refunded' AND paid_at IS NOT NULL AND refunded_at IS NOT NULL))
);
CREATE INDEX purchase_orders_access ON purchase_orders(user_id,status);
CREATE TABLE simulated_payment_events (
  event_key text PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES purchase_orders(id),
  action text NOT NULL CHECK(action IN ('pay','refund')),
  amount_fen integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION freeze_commerce_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='content_bundles' THEN RAISE EXCEPTION 'Bundle versions are immutable'; END IF;
  IF ROW(NEW.user_id,NEW.bundle_id,NEW.bundle_version,NEW.idempotency_key,NEW.title,NEW.amount_fen,NEW.currency,NEW.contents,NEW.mode)
     IS DISTINCT FROM ROW(OLD.user_id,OLD.bundle_id,OLD.bundle_version,OLD.idempotency_key,OLD.title,OLD.amount_fen,OLD.currency,OLD.contents,OLD.mode)
  THEN RAISE EXCEPTION 'Order snapshots are immutable'; END IF;
  IF (OLD.status='pending' AND NEW.status NOT IN ('pending','paid')) OR
     (OLD.status='paid' AND NEW.status NOT IN ('paid','refunded')) OR
     (OLD.status='refunded' AND NEW.status<>'refunded') THEN RAISE EXCEPTION 'Invalid order transition'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER content_bundles_frozen BEFORE UPDATE OR DELETE ON content_bundles FOR EACH ROW EXECUTE FUNCTION freeze_commerce_snapshot();
CREATE TRIGGER purchase_orders_frozen BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION freeze_commerce_snapshot();
