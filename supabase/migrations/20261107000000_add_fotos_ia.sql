-- Fotos de producto generadas con IA (Higgsfield) desde Marketing → 📸 Fotos.
--
-- Cada fila es UNA imagen de UNA variante (un SKU): la portada, la de medidas, la de
-- compatibilidad, etc. Las que se piden juntas comparten `lote`, que es lo que la pantalla
-- sigue mientras se generan.
--
-- Higgsfield no genera en el momento: acepta el pedido, devuelve un request_id y la imagen
-- aparece un minuto después. Por eso la fila pasa por estados:
--
--   pendiente  → todavía no se mandó (se mandan de a pocas: Higgsfield limita las simultáneas)
--   enviando   → se está mandando ahora mismo
--   generando  → Higgsfield la aceptó (hay hf_request_id) y la está haciendo
--   procesando → terminó; se le está poniendo el logo y se está guardando
--   lista      → guardada en Storage con el logo (url_final), lista para publicar
--   publicada  → ya se subió a MELI
--   error      → falló (el detalle queda en `error`)
--   descartada → el vendedor no la quiere
--
-- La imagen final se guarda en el bucket público `fotos-ia`: las URLs de Higgsfield vencen a
-- los 7 días, y MELI e Instagram necesitan una URL pública que siga viva para descargarla.

CREATE TABLE IF NOT EXISTS fotos_ia (
  id             BIGSERIAL PRIMARY KEY,
  lote           UUID NOT NULL,
  sku            TEXT NOT NULL,
  tipo           TEXT NOT NULL CHECK (tipo IN ('portada', 'medidas', 'compatible', 'beneficios', 'instalacion')),
  -- La de instalación es una sola para todas las variantes del lote: se genera una vez y se
  -- publica en cada una.
  compartida     BOOLEAN NOT NULL DEFAULT FALSE,
  prompt         TEXT NOT NULL,
  -- Fotos de la publicación de MELI que se le pasan a la IA para que copie el producto real.
  referencias    TEXT[] NOT NULL DEFAULT '{}',
  estado         TEXT NOT NULL DEFAULT 'pendiente'
                 CHECK (estado IN ('pendiente', 'enviando', 'generando', 'procesando', 'lista', 'publicada', 'error', 'descartada')),
  -- Desde cuándo está en el estado actual: una fila trabada en 'enviando' o 'procesando' se
  -- cortó a mitad de camino y hay que resolverla en vez de dejarla colgada para siempre.
  estado_desde   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hf_request_id  TEXT,
  hf_url         TEXT,
  url_final      TEXT,
  error          TEXT,
  publicada_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fotos_ia_lote ON fotos_ia (lote, id);
-- Lo que busca cada avance: lo que falta mandar o terminar.
CREATE INDEX IF NOT EXISTS fotos_ia_activas ON fotos_ia (estado)
  WHERE estado IN ('pendiente', 'enviando', 'generando', 'procesando');

-- Igual que el resto de las tablas: solo el backend (service key) la lee y escribe.
ALTER TABLE fotos_ia ENABLE ROW LEVEL SECURITY;

-- Bucket público para las fotos terminadas. Lo escribe solo el backend con la service key;
-- público para leer porque MELI descarga la foto desde esa URL.
INSERT INTO storage.buckets (id, name, public)
VALUES ('fotos-ia', 'fotos-ia', TRUE)
ON CONFLICT (id) DO UPDATE SET public = TRUE;

COMMENT ON TABLE fotos_ia IS
  'Fotos de producto generadas con IA (Higgsfield). Una fila por imagen y variante; las de un mismo pedido comparten lote.';
