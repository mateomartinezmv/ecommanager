-- Las publicaciones programadas también pueden salir en la página de Facebook.
--
-- `redes` dice en qué redes sale cada una: Instagram, Facebook o las dos (lo que se carga sin
-- indicar nada sale en las dos). El cron publica en cada red y guarda el id apenas sale, así
-- un reintento publica solo en la que faltaba y nada sale dos veces:
--   · Instagram → ig_media_id / permalink (ya existían)
--   · Facebook  → fb_post_id / fb_permalink

ALTER TABLE instagram_publicaciones
  ADD COLUMN IF NOT EXISTS redes TEXT[] NOT NULL DEFAULT ARRAY['instagram', 'facebook'],
  ADD COLUMN IF NOT EXISTS fb_post_id TEXT,
  ADD COLUMN IF NOT EXISTS fb_permalink TEXT;

ALTER TABLE instagram_publicaciones DROP CONSTRAINT IF EXISTS instagram_publicaciones_redes_check;
ALTER TABLE instagram_publicaciones ADD CONSTRAINT instagram_publicaciones_redes_check
  CHECK (cardinality(redes) >= 1 AND redes <@ ARRAY['instagram', 'facebook']);

-- Lo que ya salió antes de este cambio salió solo en Instagram.
UPDATE instagram_publicaciones SET redes = ARRAY['instagram']
  WHERE estado = 'publicado' AND fb_post_id IS NULL;

COMMENT ON COLUMN instagram_publicaciones.redes IS
  'Dónde sale: instagram, facebook o las dos. Sin indicar, las dos.';
