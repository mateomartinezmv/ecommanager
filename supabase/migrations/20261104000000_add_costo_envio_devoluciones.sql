-- Costo del envío de una devolución: lo que se paga para que el producto vuelva desde la
-- dirección del cliente hasta el depósito.
-- Feature: ↩️ Devoluciones → columna "Envío de vuelta"
--
-- Se carga al registrar la devolución o después (cuando llega la factura del transportista),
-- y entra directo en 📈 Reportes como "Envíos de devoluciones": resta de la ganancia neta en
-- el período de la fecha de la devolución (created_at).
--
-- 0 = sin costo (la pagó el cliente, la cubrió MELI, o todavía no se sabe).

alter table devoluciones add column if not exists costo_envio numeric(12,2) not null default 0;

comment on column devoluciones.costo_envio is
  'Costo del envío de vuelta (dirección del cliente → depósito), en UYU. Resta de la ganancia en Reportes.';
