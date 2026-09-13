-- Migration: agrupar varias líneas de venta en un solo carrito / ticket
-- Feature: cuando un mismo cliente se lleva más de un artículo (SKUs distintos),
-- cada producto sigue siendo una fila en `ventas` (para stock, devoluciones y envíos),
-- pero todas comparten `venta_grupo` y se muestran/cuentan como UNA sola venta.
-- Run in Supabase dashboard → SQL editor, o via `supabase db push`

-- venta_grupo → id del carrito (ej: 'C1757812345678'). NULL = venta de un solo ítem.
ALTER TABLE ventas
  ADD COLUMN IF NOT EXISTS venta_grupo TEXT;

CREATE INDEX IF NOT EXISTS ventas_venta_grupo_idx ON ventas (venta_grupo);

-- Se conserva al cancelar, así el histórico también sabe de qué carrito venía la línea.
ALTER TABLE ventas_canceladas
  ADD COLUMN IF NOT EXISTS venta_grupo TEXT;
