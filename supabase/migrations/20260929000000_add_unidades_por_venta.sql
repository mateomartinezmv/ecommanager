-- Productos que se venden de a pack (sliders = par, kits, etc.).
--
-- El depósito guarda SIEMPRE unidades sueltas: si hay 8 pares de sliders en la
-- estantería, stock_dep = 16, porque las cajas están armadas de a una. Lo que
-- se publica en MELI y Shopify es la cantidad de packs completos que salen de
-- ese depósito (floor(stock_dep / unidades_por_venta)), y cada venta descuenta
-- unidades_por_venta unidades por cada pack vendido.
--
-- unidades_por_venta = 1 → producto suelto de toda la vida (el caso por defecto).
alter table productos
  add column if not exists unidades_por_venta integer not null default 1;

alter table productos
  drop constraint if exists productos_unidades_por_venta_check;

alter table productos
  add constraint productos_unidades_por_venta_check
  check (unidades_por_venta >= 1);

comment on column productos.unidades_por_venta is
  'Unidades de depósito que se despachan por cada unidad vendida. 1 = suelto, 2 = par.';
