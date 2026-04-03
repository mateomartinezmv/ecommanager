-- Migration: add imports and import_items tables
-- Feature: Import History (Historial de Importaciones)
-- Run in Supabase dashboard → SQL editor, or via `supabase db push`

-- ============================================================
-- imports: one record per purchase order placed with a supplier
-- ============================================================
CREATE TABLE IF NOT EXISTS imports (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at             TIMESTAMPTZ NOT NULL    DEFAULT NOW(),
  order_date             DATE        NOT NULL,
  estimated_arrival_date DATE,                   -- set by trigger to order_date + 75 days
  actual_arrival_date    DATE,
  status                 TEXT        NOT NULL    DEFAULT 'ordered'
                           CHECK (status IN ('ordered', 'in_transit', 'arrived', 'cancelled')),
  notes                  TEXT,
  total_items            INTEGER     NOT NULL    DEFAULT 0
);

-- Auto-calculate estimated_arrival_date = order_date + 75 days when not supplied
CREATE OR REPLACE FUNCTION imports_set_estimated_arrival()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.estimated_arrival_date IS NULL THEN
    NEW.estimated_arrival_date := NEW.order_date + INTERVAL '75 days';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER imports_before_insert
  BEFORE INSERT ON imports
  FOR EACH ROW EXECUTE FUNCTION imports_set_estimated_arrival();

-- ============================================================
-- import_items: line items within each import order
-- ============================================================
CREATE TABLE IF NOT EXISTS import_items (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id        UUID          NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  sku              TEXT          NOT NULL,
  product_name     TEXT          NOT NULL,
  quantity_ordered INTEGER       NOT NULL,
  unit_cost        NUMERIC(10,2),
  currency         TEXT          NOT NULL DEFAULT 'USD'
);

CREATE INDEX IF NOT EXISTS import_items_import_id_idx ON import_items(import_id);
CREATE INDEX IF NOT EXISTS import_items_sku_idx       ON import_items(sku);
CREATE INDEX IF NOT EXISTS imports_status_idx         ON imports(status);
CREATE INDEX IF NOT EXISTS imports_order_date_idx     ON imports(order_date DESC);
