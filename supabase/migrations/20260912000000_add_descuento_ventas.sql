-- Migration: add discount columns to ventas
-- Feature: promo 10% por pago en efectivo o transferencia (ventas mostrador)
-- Run in Supabase dashboard → SQL editor, or via `supabase db push`

-- descuento_pct   → porcentaje aplicado sobre el subtotal de la línea (ej: 10.00)
-- descuento_monto → plata efectivamente descontada en esa línea
-- total ya viene con el descuento aplicado: total = precio_unit * cantidad - descuento_monto
ALTER TABLE ventas
  ADD COLUMN IF NOT EXISTS descuento_pct   NUMERIC(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS descuento_monto NUMERIC(12,2) NOT NULL DEFAULT 0;
