-- Publicación en Instagram desde el CRM (Graph API de Meta).
--
-- meta_tokens guarda la conexión con Meta, igual que meli_tokens: una sola fila (id = 1).
-- El token que se guarda es el de la página de Facebook vinculada a la cuenta de Instagram,
-- que sale de un token de usuario de larga duración y no vence: no hace falta refrescarlo.
--
-- instagram_publicaciones es la cola de lo que hay que publicar. La API de Meta no programa:
-- publica en el momento, así que el cron api/cron/instagram-publicar.js recorre esta tabla
-- cada 5 minutos y publica lo que ya llegó a su hora.

CREATE TABLE IF NOT EXISTS meta_tokens (
  id                     INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  page_id                TEXT,
  page_name              TEXT,
  page_access_token      TEXT,
  ig_user_id             TEXT,
  ig_username            TEXT,
  -- Vencimiento del token de usuario con el que se sacó el de la página. Solo informativo:
  -- el token de página sigue andando después de esta fecha.
  user_token_expires_at  TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS instagram_publicaciones (
  id               BIGSERIAL PRIMARY KEY,
  tipo             TEXT NOT NULL CHECK (tipo IN ('post', 'carrusel', 'historia')),
  -- URLs públicas de JPEG, en el orden en que salen. Meta las descarga desde su lado.
  imagenes         TEXT[] NOT NULL CHECK (cardinality(imagenes) BETWEEN 1 AND 10),
  caption          TEXT,
  programado_para  TIMESTAMPTZ NOT NULL,
  estado           TEXT NOT NULL DEFAULT 'programado'
                   CHECK (estado IN ('programado', 'publicando', 'publicado', 'error', 'cancelado')),
  -- Cuándo se tomó para publicar: una fila que quedó en 'publicando' mucho tiempo se cortó
  -- a mitad de camino y el cron la marca con error en vez de reintentarla a ciegas.
  publicando_desde TIMESTAMPTZ,
  intentos         INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  ig_media_id      TEXT,
  permalink        TEXT,
  publicado_at     TIMESTAMPTZ,
  notas            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lo que busca el cron: lo programado ordenado por hora.
CREATE INDEX IF NOT EXISTS instagram_publicaciones_pendientes
  ON instagram_publicaciones (programado_para) WHERE estado = 'programado';

-- Igual que el resto de las tablas: solo el backend (service key) las lee y escribe.
ALTER TABLE meta_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_publicaciones ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE instagram_publicaciones IS
  'Cola de publicaciones de Instagram. El cron instagram-publicar publica las programadas cuando llega su hora.';
COMMENT ON COLUMN instagram_publicaciones.imagenes IS
  'URLs públicas de imágenes JPEG (Meta no acepta PNG). Un carrusel lleva de 2 a 10.';
