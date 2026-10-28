-- Descuento de stock atómico para las ventas que llegan por webhook.
--
-- MELI manda 5-7 avisos orders_v2 por orden, varios en el mismo segundo. El
-- webhook leía stock_dep, restaba y escribía el resultado: cada aviso que
-- llegaba antes de que se registrara la venta volvía a descontar sobre el
-- valor ya descontado. Una venta de 1 unidad llegó a bajar 3 (27/10/2026,
-- ALERONFINOSNK 9 → 6).
--
-- Con esto la resta la hace Postgres en un solo UPDATE (sin leer antes), y el
-- espejo de los canales se recalcula en el mismo paso, igual que en
-- _packs.js: packs completos = floor(stock_dep / unidades_por_venta).
-- Devuelve el stock_dep que quedó, o NULL si el SKU no existe.

create or replace function public.descontar_stock(p_sku text, p_unidades integer)
returns integer
language sql
as $$
  update productos
     set stock_dep     = greatest(0, stock_dep - p_unidades),
         stock_meli    = greatest(0, stock_dep - p_unidades) / greatest(1, unidades_por_venta),
         stock_shopify = greatest(0, stock_dep - p_unidades) / greatest(1, unidades_por_venta),
         updated_at    = now()
   where sku = p_sku
  returning stock_dep;
$$;

-- Sólo el backend (service_role) mueve stock: no queda expuesta a la API pública.
revoke all on function public.descontar_stock(text, integer) from public, anon, authenticated;
grant execute on function public.descontar_stock(text, integer) to service_role;
