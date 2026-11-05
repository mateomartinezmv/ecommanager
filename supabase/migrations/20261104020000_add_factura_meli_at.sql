-- Migration: cuándo se subió a MELI el PDF de la factura de una venta
-- Feature: facturación de ventas MELI con Gesta. Una venta MELI pasa por dos pasos:
--   1. facturada = TRUE  → ya se emitió el eTicket en Gesta (no vuelve a salir en el Excel).
--   2. factura_meli_at   → el PDF de ese eTicket ya está adjunto a la venta en MELI.
-- NULL = todavía no se subió.
-- Run in Supabase dashboard → SQL editor, o via `supabase db push`

ALTER TABLE ventas
  ADD COLUMN IF NOT EXISTS factura_meli_at TIMESTAMPTZ;
