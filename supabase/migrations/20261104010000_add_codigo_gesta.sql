-- Migration: código del producto en Gesta (gesta.uy, facturación electrónica)
-- Feature: el Excel de importación de ventas de Gesta pide en CÓDIGO PRODUCTO el número que
-- Gesta le dio a cada producto al darlo de alta (1, 2, 3...), no el SKU. Esta columna guarda
-- esa equivalencia. NULL = el producto no está en Gesta (a propósito): sus ventas no salen en
-- el Excel.
-- Run in Supabase dashboard → SQL editor, o via `supabase db push`

ALTER TABLE productos
  ADD COLUMN IF NOT EXISTS codigo_gesta INTEGER;
