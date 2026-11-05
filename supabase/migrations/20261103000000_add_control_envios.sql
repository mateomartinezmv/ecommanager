-- Control de despacho: verificar con el lector de códigos que lo que entra en cada
-- paquete es lo que se vendió.
-- Feature: 🚚 Envíos → ✅ Control de despacho
--
-- Quien arma escanea la etiqueta de MELI del paquete y después la etiqueta SKU de cada
-- producto que mete en la caja. El CRM compara contra las ventas del envío y, cuando está
-- todo, marca el envío como controlado.
--
-- meli_shipment_id → el número del código de barras de la etiqueta de MELI. En Mercado
--   Envíos ya viene adentro del tracking ("MEL48412750656FMDOF01"), pero en Flex el
--   tracking es otro código, así que se guarda aparte. Lo completan el webhook de shipments
--   y la sincronización de envíos; si un envío todavía no lo tiene, la pantalla de control
--   lo resuelve contra MELI la primera vez que se escanea la etiqueta.
-- controlado_at → cuándo se terminó de controlar el paquete (null = sin controlar).
-- control → el detalle: qué se esperaba, qué se escaneó, lo marcado a mano y los
--   escaneos equivocados que el control frenó.
--   { "items": [{ "sku", "esperado", "escaneado", "manual" }],
--     "errores": [{ "tipo": "otro_producto" | "sobra" | "desconocido", "codigo", "sku", "at" }],
--     "inicio", "fin" }

alter table envios add column if not exists meli_shipment_id text;
alter table envios add column if not exists controlado_at timestamptz;
alter table envios add column if not exists control jsonb;

create index if not exists envios_meli_shipment_id_idx on envios (meli_shipment_id);

-- Mercado Envíos: el número del shipment ya está en el tracking.
update envios
   set meli_shipment_id = substring(tracking from '^MEL(\d+)')
 where meli_shipment_id is null
   and tracking ~ '^MEL\d+';

comment on column envios.meli_shipment_id is
  'Id del shipment de MELI = el número del código de barras de la etiqueta. Lo usa el control de despacho.';
comment on column envios.controlado_at is
  'Cuándo se terminó de controlar el paquete con el lector (null = sin controlar).';
comment on column envios.control is
  'Detalle del control de despacho: items esperados/escaneados/manuales y escaneos equivocados.';
