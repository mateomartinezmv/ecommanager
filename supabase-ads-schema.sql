-- Tabla para almacenar gastos diarios de Mercado Ads por campaña
CREATE TABLE IF NOT EXISTS meli_ads_gastos (
  id SERIAL PRIMARY KEY,
  fecha DATE NOT NULL,
  campaign_id TEXT,
  campaign_name TEXT,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  spend NUMERIC(12,2) DEFAULT 0,
  currency TEXT DEFAULT 'UYU',
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índice único para evitar duplicados por fecha+campaña (permite UPSERT)
CREATE UNIQUE INDEX IF NOT EXISTS meli_ads_gastos_fecha_campaign
  ON meli_ads_gastos(fecha, campaign_id);
