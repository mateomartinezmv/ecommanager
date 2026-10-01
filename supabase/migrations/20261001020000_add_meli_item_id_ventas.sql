-- Un SKU puede tener varias publicaciones en MELI (es común duplicar una con
-- distintos ángulos de venta), y hasta ahora la venta no dejaba registro de cuál
-- fue la que vendió: el CRM guarda el nombre interno del producto, no el título
-- de la publicación. Sin este dato no se puede medir qué ángulo funciona ni
-- explicar por qué el título de la venta en MELI no coincide con el del CRM.
--
-- El id de las ventas automáticas ya lo contiene (V_MELI_<order>_<MLU...>), pero
-- ahí no es consultable; en columna sí, y las cargadas a mano también lo tienen.
alter table ventas add column if not exists meli_item_id text;

create index if not exists idx_ventas_meli_item_id on ventas (meli_item_id) where meli_item_id is not null;

comment on column ventas.meli_item_id is
  'Publicación de MELI (MLU...) por la que se vendió. Un mismo SKU puede tener varias.';
