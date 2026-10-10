DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM purchase_orders) THEN RAISE EXCEPTION 'Cannot roll back commerce with order history'; END IF;
END $$;
DROP TABLE simulated_payment_events;
DROP TABLE purchase_orders;
DROP TABLE content_bundles;
DROP FUNCTION freeze_commerce_snapshot();
