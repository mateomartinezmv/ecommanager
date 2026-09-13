-- Soporte de múltiples publicaciones MELI por producto.
--
-- Duplicar una publicación con distintos ángulos de venta es práctica común,
-- pero el CRM sólo conocía una por SKU (productos.meli_id): las órdenes que
-- llegaban por cualquier otra publicación no encontraban producto y se
-- descartaban en silencio, sin registrar la venta ni descontar stock.
--
-- productos.meli_ids pasa a ser la fuente de verdad. productos.meli_id queda
-- como "publicación principal" (= meli_ids[1]), derivada por trigger, para no
-- romper el código que todavía la lee.

ALTER TABLE productos
  ADD COLUMN IF NOT EXISTS meli_ids text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN productos.meli_ids IS
  'Todas las publicaciones MELI de este SKU. Fuente de verdad para resolver el producto de una orden y para empujar stock. meli_ids[1] se espeja en meli_id.';
COMMENT ON COLUMN productos.meli_id IS
  'Publicación MELI principal (= meli_ids[1]). Derivada: la mantiene el trigger productos_meli_ids_sync.';

-- Backfill: lo que ya estaba vinculado pasa a ser la publicación principal.
UPDATE productos
   SET meli_ids = ARRAY[meli_id]
 WHERE meli_id IS NOT NULL
   AND cardinality(meli_ids) = 0;

CREATE INDEX IF NOT EXISTS productos_meli_ids_gin
  ON productos USING GIN (meli_ids);

-- Normaliza meli_ids, espeja meli_id y evita que una publicación quede
-- vinculada a dos SKUs distintos.
CREATE OR REPLACE FUNCTION productos_meli_ids_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ids   text[];
  dueno text;
BEGIN
  ids := COALESCE(NEW.meli_ids, '{}');

  IF TG_OP = 'UPDATE'
     AND NEW.meli_ids IS NOT DISTINCT FROM OLD.meli_ids
     AND NEW.meli_id  IS DISTINCT FROM OLD.meli_id THEN
    -- Escritura por el camino viejo: tocaron meli_id y no meli_ids.
    IF NEW.meli_id IS NULL THEN
      ids := COALESCE(array_remove(COALESCE(OLD.meli_ids, '{}'), OLD.meli_id), '{}');
    ELSIF OLD.meli_id IS NULL THEN
      ids := ARRAY[NEW.meli_id] || COALESCE(OLD.meli_ids, '{}');
    ELSE
      ids := array_replace(COALESCE(OLD.meli_ids, '{}'), OLD.meli_id, NEW.meli_id);
      IF NOT (NEW.meli_id = ANY (ids)) THEN
        ids := ARRAY[NEW.meli_id] || ids;
      END IF;
    END IF;
  ELSIF cardinality(ids) = 0 AND NEW.meli_id IS NOT NULL THEN
    ids := ARRAY[NEW.meli_id];
  END IF;

  -- Trim, descartar vacíos y deduplicar conservando el orden de carga.
  SELECT COALESCE(array_agg(v ORDER BY ord), '{}')
    INTO ids
    FROM (
      SELECT DISTINCT ON (btrim(v)) btrim(v) AS v, ord
        FROM unnest(ids) WITH ORDINALITY AS u(v, ord)
       WHERE btrim(COALESCE(v, '')) <> ''
       ORDER BY btrim(v), ord
    ) d;

  NEW.meli_ids := ids;
  NEW.meli_id  := CASE WHEN cardinality(ids) > 0 THEN ids[1] ELSE NULL END;

  -- Una publicación no puede pertenecer a dos SKUs.
  IF cardinality(ids) > 0 THEN
    SELECT p.sku INTO dueno
      FROM productos p
     WHERE p.id <> NEW.id
       AND p.meli_ids && ids
     LIMIT 1;
    IF dueno IS NOT NULL THEN
      RAISE EXCEPTION 'Esa publicación MELI ya está vinculada al SKU %', dueno
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS productos_meli_ids_sync ON productos;
CREATE TRIGGER productos_meli_ids_sync
  BEFORE INSERT OR UPDATE ON productos
  FOR EACH ROW EXECUTE FUNCTION productos_meli_ids_sync();
