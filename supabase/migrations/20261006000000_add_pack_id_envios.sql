-- Carritos de MELI: una compra con varios productos no llega como una orden con
-- varios ítems, sino como una orden por publicación atadas por un mismo
-- `pack_id` y un único envío.
--
-- `ventas.pack_id` / `ventas.meli_item_id` ya existían en la base (se agregaron
-- a mano); se declaran acá para que el repo y la base digan lo mismo.
-- `envios.pack_id` es nuevo: identifica el paquete y es lo que evita que el
-- flete se cobre una vez por producto.

alter table ventas add column if not exists pack_id text;
alter table ventas add column if not exists meli_item_id text;
alter table envios add column if not exists pack_id text;

create index if not exists ventas_pack_id_idx on ventas (pack_id);
create index if not exists envios_pack_id_idx on envios (pack_id);
