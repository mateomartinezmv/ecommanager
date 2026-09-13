-- Reconciliación de AP-TAILBOXLED (Baúl Trasero 28L) — aplicada el 2026-09-13.
--
-- El SKU tenía dos publicaciones en MELI (MLU1475174210 y MLU1475174254) y el
-- CRM sólo conocía la primera, así que las ventas de la segunda no se
-- registraban ni descontaban stock. El CRM marcaba 8 unidades contra 1 real.
--
-- Se deja como registro de lo que se corrigió. Ya está aplicado: no re-ejecutar.

-- 1. Vincular ambas publicaciones al SKU.
update productos
   set meli_ids = array['MLU1475174210','MLU1475174254'], updated_at = now()
 where sku = 'AP-TAILBOXLED';

-- 2. Alta de las 8 órdenes que faltaban (7 pagadas + 1 cancelada), tomando
--    fecha, comprador, precio y comisión de /orders/search de MELI.
--    Órdenes: 2000017917609344, 2000018129731474, 2000018251468620,
--             2000018284370964 (cancelada), 2000018296329100,
--             2000018325140884, 2000018327757062, 2000018356456050.

-- 3. La venta de FRODRIGUEZ4132 había quedado con sku NULL (la insertó
--    reprocesar-ordenes cuando la publicación no estaba vinculada).
update ventas v
   set sku = p.sku, producto = p.nombre
  from productos p
 where p.sku = 'AP-TAILBOXLED'
   and v.id = 'V_MELI_2000018216835858_MLU1475174254';

-- 4. Dos órdenes entregadas fueron reembolsadas por mediación de MELI y
--    figuraban (o habrían figurado) como facturadas.
update ventas
   set estado = 'cancelada',
       notas  = 'Reembolsada por MELI (reclamo 5563328832, coverage_decision, 20/08). El baul fue entregado y no volvio: perdida de mercaderia.'
 where id = 'V_MELI_2000017983401578_MLU1475174254';

update ventas
   set notas = 'Reembolsada por MELI (reclamo 5574666654, item_returned, 10/09). El baul volvio defectuoso y se dio de baja: no reingresa a stock.'
 where id = 'V_MELI_2000018284370964_MLU1475174254';

-- 5. Dos ventas cargadas a mano llevaban números de orden inexistentes en MELI
--    (2000014515225989 y 2000014787360493 → 404). Sus órdenes reales quedaron
--    cargadas con el ID válido en el paso 2. El envío de la primera tenía costo
--    real de transportista ya pagado, así que se repuntó en vez de borrarse;
--    el de la segunda duplicaba un envío que ya existía.
update envios
   set venta_id = 'V_MELI_2000017917609344_MLU1475174254',
       orden = '2000017917609344', comprador = 'ARIANA C.'
 where id = 'E1786664987799';
delete from envios where id = 'E1788189359183';
delete from ventas where id in ('V1786664906738','V1788189346994');

-- 6. Stock a la realidad del depósito.
update productos
   set stock_dep = 1, stock_meli = 1, stock_shopify = 1, updated_at = now()
 where sku = 'AP-TAILBOXLED';

-- Pendiente: empujar stock_dep a ambas publicaciones con
-- POST /api/meli/sync-stock {"sku":"AP-TAILBOXLED"} una vez deployado.
