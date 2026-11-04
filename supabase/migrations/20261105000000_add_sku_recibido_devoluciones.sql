-- Devolución de un producto equivocado: el cliente pidió A (lo que dice la venta), le
-- mandamos B por error y devuelve B.
-- Feature: ↩️ Devoluciones → "Le mandamos un producto equivocado"
--
-- sku_recibido / producto_recibido → B, el producto que le llegó al cliente y que vuelve.
--   null = devolución común (vuelve lo mismo que dice la venta).
--
-- Cómo se mueve el stock (el producto correcto se le reenvía al cliente sin cargar una venta
-- nueva, así que el descuento que ya hizo la venta de A es el del reenvío):
--   · al registrar la devolución → B −cantidad: salió del depósito sin descontarse y está
--     en lo del cliente.
--   · al confirmar que llegó     → B +cantidad (en vez de sumarle a A).
--   · borrar una pendiente       → B +cantidad (se deshace el descuento del registro).
-- A no se toca en ningún paso.

alter table devoluciones add column if not exists sku_recibido text;
alter table devoluciones add column if not exists producto_recibido text;

comment on column devoluciones.sku_recibido is
  'SKU que le llegó al cliente cuando se le mandó un producto equivocado (null = el de la venta). Es el que se descuenta al registrar y se suma al recibir.';
comment on column devoluciones.producto_recibido is
  'Nombre del producto equivocado que le llegó al cliente, para mostrarlo sin buscarlo.';
