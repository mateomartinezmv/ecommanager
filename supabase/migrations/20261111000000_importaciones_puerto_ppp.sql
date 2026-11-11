-- Importaciones con el esquema de puesta en puerto (importador GrupoRAS) y costo por PPP.
--
--   importador          quién trae la mercadería (GrupoRAS); el proveedor sigue siendo la
--                       fábrica en China (proveedor_id).
--   costo_puerto        cotización del importador: FOB + flete hasta el puerto, todo pago, en USD.
--                       Incluye el costo en China. Si es null, la importación es del esquema
--                       anterior y `total` es lo pagado con IVA.
--   cotizacion_usd      pesos por dólar para pasar el costo de cada unidad a productos.costo.
--   pagos               los tres pagos: [{id, concepto, a, monto, estimado, estimado_manual,
--                       pagado, fecha_pago}].
--   costos_aplicados    lo que hizo el PPP al llegar: [{sku, qty, stockAntes, costoAntes,
--                       costoImport, costoNuevo}]. Con costos_aplicados_at no se vuelve a aplicar.
--
-- `nacional` y `traslado` ya existían (USD). `total` pasa a ser costo_puerto + nacional +
-- traslado, sin IVA.

alter table importaciones add column if not exists importador text;
alter table importaciones add column if not exists costo_puerto numeric;
alter table importaciones add column if not exists cotizacion_usd numeric;
alter table importaciones add column if not exists pagos jsonb;
alter table importaciones add column if not exists costos_aplicados jsonb;
alter table importaciones add column if not exists costos_aplicados_at timestamptz;
