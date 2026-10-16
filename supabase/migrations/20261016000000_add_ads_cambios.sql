-- Registro de cambios hechos a las campañas y anuncios de Mercado Ads.
--
-- Cada fila es un cambio: el presupuesto de una campaña, su ROAS objetivo, pausar o
-- reactivar una campaña o un anuncio. Los que se aplican desde el CRM se guardan solos
-- (origen = 'crm'); los que se hacen directo en MELI se pueden cargar a mano para que
-- también tengan su "antes y después".
--
-- El antes y después no se guarda: se calcula al leer, desde meli_ads_anuncios, las dos
-- semanas previas al cambio contra las dos siguientes. Así un día que MELI corrige después
-- se refleja solo.
CREATE TABLE IF NOT EXISTS meli_ads_cambios (
  id              BIGSERIAL PRIMARY KEY,
  fecha           DATE NOT NULL DEFAULT CURRENT_DATE,
  nivel           TEXT NOT NULL CHECK (nivel IN ('campana', 'anuncio')),
  campaign_id     TEXT,
  campaign_name   TEXT,
  ad_group_id     TEXT,
  titulo          TEXT,
  campo           TEXT NOT NULL CHECK (campo IN ('presupuesto', 'roas_objetivo', 'estado')),
  valor_anterior  TEXT,
  valor_nuevo     TEXT,
  origen          TEXT NOT NULL DEFAULT 'crm' CHECK (origen IN ('crm', 'manual')),
  nota            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS meli_ads_cambios_fecha ON meli_ads_cambios(fecha DESC);
