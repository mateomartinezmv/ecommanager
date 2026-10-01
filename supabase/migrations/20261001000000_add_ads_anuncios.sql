-- Snapshot diario de Ads a nivel anuncio (ad group).
--
-- meli_ads_diario guarda el gasto total del día; esta tabla lo abre por producto.
-- MELI agrupa todas las variantes de un producto bajo un ad_group_id (el "5 variantes"
-- que se ve en el panel), así que la fila es el ad group, no el item_id.
--
-- Igual que con meli_ads_diario: MELI sólo sirve 90 días de métricas, así que lo que no
-- se capture dentro de esa ventana se pierde. La PK (fecha, ad_group_id) permite re-pedir
-- los mismos días sin duplicar.
CREATE TABLE IF NOT EXISTS meli_ads_anuncios (
  fecha           DATE NOT NULL,
  ad_group_id     TEXT NOT NULL,
  campaign_id     TEXT,
  campaign_name   TEXT,
  titulo          TEXT,
  thumbnail       TEXT,
  status          TEXT,
  ad_group_type   TEXT,          -- FAMILY (con variantes) o ITEM (publicación suelta)
  item_ids        TEXT[] DEFAULT '{}',
  sku             TEXT,          -- resuelto contra productos.meli_ids al capturar
  impressions     INTEGER DEFAULT 0,
  clicks          INTEGER DEFAULT 0,
  spend           NUMERIC(12,2) DEFAULT 0,
  facturacion     NUMERIC(12,2) DEFAULT 0,
  unidades        INTEGER DEFAULT 0,
  currency        TEXT DEFAULT 'UYU',
  fetched_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (fecha, ad_group_id)
);

CREATE INDEX IF NOT EXISTS meli_ads_anuncios_campaign ON meli_ads_anuncios(campaign_id, fecha);
CREATE INDEX IF NOT EXISTS meli_ads_anuncios_sku      ON meli_ads_anuncios(sku, fecha);
