-- El panel de MELI ("Central de vendedores" → Ventas) no muestra el id de la orden:
-- muestra el pack_id, que es el número del carrito y es distinto del order_id en
-- casi la mitad de las ventas. Como el CRM sólo guardaba orden_meli (= order_id),
-- buscar una venta por el número que figura en pantalla en MELI no encontraba nada
-- y parecía que la venta no se había registrado.
--
-- Se guarda el pack_id tal cual lo devuelve la API para poder buscar por cualquiera
-- de los dos números. Queda NULL en las ventas que no son parte de un carrito.
alter table ventas add column if not exists pack_id text;

create index if not exists idx_ventas_pack_id on ventas (pack_id) where pack_id is not null;

comment on column ventas.pack_id is
  'pack_id de MELI (el número que muestra el panel de vendedores como "Venta #"). Distinto de orden_meli = order_id.';
