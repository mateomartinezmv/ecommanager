-- Migration: marcar a mano si una venta fue facturada
-- Feature: check en la tabla de ventas (pensado para mostrador) que se selecciona y
-- deselecciona para dejar registrado si esa venta salió con factura o no.
-- Run in Supabase dashboard → SQL editor, o via `supabase db push`

-- facturada → TRUE/FALSE marcado a mano. NULL = sin marcar: el tope del Literal E sigue
-- deduciéndolo del método de pago (contado no factura), como venía haciendo hasta ahora.
-- Por eso la columna es nullable y no tiene default: hace falta distinguir "no facturada"
-- de "todavía nadie la tocó".
ALTER TABLE ventas
  ADD COLUMN IF NOT EXISTS facturada BOOLEAN;

CREATE INDEX IF NOT EXISTS ventas_facturada_idx ON ventas (facturada);
