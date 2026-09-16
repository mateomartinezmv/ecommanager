-- Historial de las publicaciones creadas como ángulo de venta adicional.
--
-- Un mismo producto se busca de varias formas ("manillar", "manubrio", "para cross"). Una
-- sola publicación sólo aparece en las búsquedas que pegan con su título, así que cada
-- producto lleva varias publicaciones activas apuntando a búsquedas distintas. La original
-- nunca se baja: las nuevas se suman.
--
-- Esta tabla es el registro de qué se creó, desde qué publicación y con qué ángulo. Sirve
-- para no volver a proponer lo mismo, para rastrear una publicación hasta su molde, y para
-- que quede constancia de los intentos fallidos con el error que devolvió MELI.
--
-- El vínculo publicación -> SKU vive en productos.meli_ids, que es lo que usan el empuje de
-- stock y el alta de ventas. Esta tabla no lo reemplaza: es historial.
CREATE TABLE IF NOT EXISTS meli_angulos (
  id             BIGSERIAL PRIMARY KEY,
  sku            TEXT        NOT NULL,
  origen_meli_id TEXT        NOT NULL,
  nuevo_meli_id  TEXT,
  angulo         TEXT,
  titulo         TEXT        NOT NULL,
  permalink      TEXT,
  estado         TEXT        NOT NULL DEFAULT 'publicada',
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE meli_angulos IS
  'Publicaciones creadas como ángulo de venta adicional de un producto que ya estaba publicado. Historial: el vínculo que cuenta para stock y ventas es productos.meli_ids.';
COMMENT ON COLUMN meli_angulos.origen_meli_id IS
  'Publicación que se usó de molde (fotos, ficha técnica, precio, garantía, envío).';
COMMENT ON COLUMN meli_angulos.estado IS
  'publicada = MELI la creó · error = MELI la rechazó, el motivo queda en error.';

CREATE INDEX IF NOT EXISTS meli_angulos_sku_idx ON meli_angulos (sku);
CREATE UNIQUE INDEX IF NOT EXISTS meli_angulos_nuevo_idx ON meli_angulos (nuevo_meli_id) WHERE nuevo_meli_id IS NOT NULL;
