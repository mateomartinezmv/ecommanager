-- Migration: campos del tarifario UES en la tabla envios
-- Feature: autocompletado de costos UES (servicio + medida/peso + despacho)
-- Run in Supabase dashboard → SQL editor, or via `supabase db push`

-- ues_servicio : clave del servicio UES elegido
--                (ues24_mvd | ues24_mvd_dia | ues_interior | uespu | intpu)
-- ues_tramo_kg : tope de peso del tramo tarifario (0.2, 1, 2, 5, 10, 20, 30, 40, 50)
-- ues_despacho : cómo se entrega la mercadería a UES (xpres = punto Xpres! sin costo,
--                levante = levante en depósito, $248 + IVA)
ALTER TABLE envios
  ADD COLUMN IF NOT EXISTS ues_servicio TEXT,
  ADD COLUMN IF NOT EXISTS ues_tramo_kg NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS ues_despacho TEXT;

ALTER TABLE envios DROP CONSTRAINT IF EXISTS envios_ues_servicio_check;
ALTER TABLE envios ADD CONSTRAINT envios_ues_servicio_check
  CHECK (ues_servicio IS NULL OR ues_servicio IN
    ('ues24_mvd', 'ues24_mvd_dia', 'ues_interior', 'uespu', 'intpu'));

ALTER TABLE envios DROP CONSTRAINT IF EXISTS envios_ues_despacho_check;
ALTER TABLE envios ADD CONSTRAINT envios_ues_despacho_check
  CHECK (ues_despacho IS NULL OR ues_despacho IN ('xpres', 'levante'));
