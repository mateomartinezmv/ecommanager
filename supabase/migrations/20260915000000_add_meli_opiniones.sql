-- Estrellas de cada publicación de MELI, cacheadas.
--
-- MELI no expone las opiniones junto con el ítem: hay que pedir /reviews/item/{id} una vez
-- por publicación. Hacer eso en vivo cada vez que se abre la pantalla es lento y quema rate
-- limit, así que el refresco se dispara a mano ("Actualizar desde MELI") y acá queda el
-- resultado. La pantalla lee esta tabla.
--
-- rating NULL significa "todavía no tiene opiniones", que es distinto de "0 estrellas": sin
-- opiniones la publicación no entra en la lista de las que conviene republicar.
CREATE TABLE IF NOT EXISTS meli_opiniones (
  meli_id          TEXT PRIMARY KEY,
  titulo           TEXT,
  permalink        TEXT,
  estado           TEXT,
  sku              TEXT,
  stock            INTEGER     NOT NULL DEFAULT 0,
  vendidos         INTEGER     NOT NULL DEFAULT 0,
  rating           NUMERIC(3,2),
  total_opiniones  INTEGER     NOT NULL DEFAULT 0,
  una_estrella     INTEGER     NOT NULL DEFAULT 0,
  dos_estrellas    INTEGER     NOT NULL DEFAULT 0,
  tres_estrellas   INTEGER     NOT NULL DEFAULT 0,
  cuatro_estrellas INTEGER     NOT NULL DEFAULT 0,
  cinco_estrellas  INTEGER     NOT NULL DEFAULT 0,
  republicada_at   TIMESTAMPTZ,
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE meli_opiniones IS
  'Caché de las estrellas de cada publicación MELI (rating_average de /reviews/item). '
  'Se refresca a pedido desde la pantalla de Opiniones.';
COMMENT ON COLUMN meli_opiniones.rating IS
  'Promedio de estrellas (1 a 5). NULL = la publicación todavía no tiene opiniones.';
COMMENT ON COLUMN meli_opiniones.republicada_at IS
  'Cuándo el vendedor marcó la publicación como ya republicada. La marca la pone la persona, '
  'no el refresco: el upsert de estrellas no toca esta columna.';

-- La consulta de la pantalla ordena por estrellas y filtra las flojas.
CREATE INDEX IF NOT EXISTS meli_opiniones_rating_idx ON meli_opiniones (rating);
CREATE INDEX IF NOT EXISTS meli_opiniones_sku_idx ON meli_opiniones (sku);
