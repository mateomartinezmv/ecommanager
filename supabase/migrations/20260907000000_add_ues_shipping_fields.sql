-- Migration: campos del tarifario UES en la tabla envios
-- Feature: autocompletado de costos UES (servicio + medida/peso)
-- Run in Supabase dashboard → SQL editor, or via `supabase db push`

-- ues_servicio : clave del servicio UES elegido
--                (ues24_mvd | ues24_mvd_dia | ues_interior | uespu | intpu)
-- ues_tramo_kg : tope de peso del tramo tarifario (0.2, 1, 2, 5, 10, 20, 30, 40, 50)
--
-- El levante de mercadería de UES ($248 + IVA) no lleva columna propia: se cobra
-- con el campo `colecta`, igual que el retiro de $75 del resto de los transportistas.
ALTER TABLE envios
  ADD COLUMN IF NOT EXISTS ues_servicio TEXT,
  ADD COLUMN IF NOT EXISTS ues_tramo_kg NUMERIC(5,2);

ALTER TABLE envios DROP CONSTRAINT IF EXISTS envios_ues_servicio_check;
ALTER TABLE envios ADD CONSTRAINT envios_ues_servicio_check
  CHECK (ues_servicio IS NULL OR ues_servicio IN
    ('ues24_mvd', 'ues24_mvd_dia', 'ues_interior', 'uespu', 'intpu'));
