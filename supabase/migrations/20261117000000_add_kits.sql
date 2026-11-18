-- Kits: una publicación que vende varios productos del depósito juntos
-- (par de espejos alerón + protectores de levas, par de espejos + porta matrícula).
--
-- Un kit es una fila más de `productos` (su SKU, nombre, precio, costo y publicaciones de
-- MELI), pero no tiene cajas propias: se arma en el momento con las piezas. Por eso:
--
--   · kit_componentes dice qué piezas lleva y cuántas unidades del depósito de cada una.
--   · El stock del kit NO se carga a mano: es cuántos kits completos salen de las piezas,
--     o sea el de la pieza que menos alcanza (min(floor(stock_dep / cantidad))).
--   · Vender un kit descuenta las piezas (descontar_stock), y cualquier movimiento de una
--     pieza —venta suelta, devolución, importación, ajuste— recalcula los kits que la usan.
--
-- Las piezas siguen vendiéndose sueltas: el kit y la publicación suelta comparten el mismo
-- depósito, así que el espejo que se va en un kit ya no está para la suelta y viceversa.
--
-- Todo vive en la base (triggers) para que lo cumplan también los caminos que no pasan por
-- api/_stockSync.js (las funciones de Supabase que procesan órdenes, el SQL Editor).
-- Lo que la base no hace es empujar el número a MELI: eso lo hace _stockSync.js en el
-- momento y, como red, el cron sync-stock-pubs cada hora.
--
-- No se anidan kits: un kit no puede ser pieza de otro.

create table if not exists kit_componentes (
  kit_sku        text    not null references productos(sku) on update cascade on delete cascade,
  componente_sku text    not null references productos(sku) on update cascade on delete restrict,
  -- Unidades del DEPÓSITO de la pieza que lleva cada kit (las mismas unidades de stock_dep).
  cantidad       integer not null default 1 check (cantidad >= 1),
  created_at     timestamptz not null default now(),
  primary key (kit_sku, componente_sku),
  check (kit_sku <> componente_sku)
);

create index if not exists idx_kit_componentes_componente on kit_componentes (componente_sku);

comment on table kit_componentes is
  'Piezas de cada kit. El stock del kit es el de la pieza que menos alcanza; vender un kit descuenta las piezas.';
comment on column kit_componentes.cantidad is
  'Unidades de stock_dep de la pieza que se van por cada kit vendido.';

-- Sólo el backend toca esto (igual que productos).
alter table kit_componentes enable row level security;

-- ── Stock de un kit ──────────────────────────────────────────────────────────
-- Kits completos que salen de las piezas. Sin piezas cargadas → 0.
create or replace function public.stock_kit(p_kit text)
returns integer
language sql
stable
as $$
  select coalesce(min(greatest(0, c.stock_dep) / k.cantidad), 0)::integer
    from kit_componentes k
    join productos c on c.sku = k.componente_sku
   where k.kit_sku = p_kit;
$$;

-- ── El kit no acepta un stock escrito a mano ─────────────────────────────────
-- Cualquier UPDATE que toque stock_dep de un kit (el formulario de Stock, un
-- sincronizarStock viejo) termina en el valor calculado. Los espejos de los canales salen
-- del mismo número.
create or replace function public.kits_stock_calculado()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from kit_componentes where kit_sku = new.sku) then
    new.stock_dep     := public.stock_kit(new.sku);
    new.stock_meli    := new.stock_dep / greatest(1, coalesce(new.unidades_por_venta, 1));
    new.stock_shopify := new.stock_meli;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_kits_stock_calculado on productos;
create trigger trg_kits_stock_calculado
  before update of stock_dep, stock_meli, stock_shopify on productos
  for each row execute function public.kits_stock_calculado();

-- ── Una pieza cambió → se recalculan los kits que la usan ────────────────────
-- AFTER ROW: si un mismo UPDATE baja dos piezas del mismo kit (la venta de un kit), los
-- triggers corren al terminar el UPDATE y ven las dos.
create or replace function public.kits_recalcular_por_pieza()
returns trigger
language plpgsql
as $$
begin
  update productos p
     set stock_dep  = public.stock_kit(p.sku),   -- el BEFORE de arriba completa los espejos
         updated_at = now()
   where p.sku in (select kit_sku from kit_componentes where componente_sku = new.sku);
  return null;
end;
$$;

drop trigger if exists trg_kits_recalcular_por_pieza on productos;
create trigger trg_kits_recalcular_por_pieza
  after update of stock_dep on productos
  for each row
  when (old.stock_dep is distinct from new.stock_dep)
  execute function public.kits_recalcular_por_pieza();

-- ── Se cargan o se cambian las piezas de un kit → se recalcula ese kit ───────
create or replace function public.kits_recalcular_por_receta()
returns trigger
language plpgsql
as $$
declare
  v_kit text := coalesce(new.kit_sku, old.kit_sku);
begin
  -- No se anidan kits: una pieza no puede ser un kit, ni un kit pieza de otro.
  if tg_op <> 'DELETE' then
    if exists (select 1 from kit_componentes where kit_sku = new.componente_sku)
       or exists (select 1 from kit_componentes where componente_sku = new.kit_sku) then
      raise exception 'Los kits no se anidan: % no puede llevar a %', new.kit_sku, new.componente_sku;
    end if;
  end if;

  update productos
     set stock_dep  = public.stock_kit(sku),
         updated_at = now()
   where sku = v_kit;
  return null;
end;
$$;

drop trigger if exists trg_kits_recalcular_por_receta on kit_componentes;
create trigger trg_kits_recalcular_por_receta
  after insert or update or delete on kit_componentes
  for each row execute function public.kits_recalcular_por_receta();

-- ── descontar_stock entiende kits ────────────────────────────────────────────
-- Misma firma y mismo contrato que antes (resta atómica, devuelve el stock_dep que quedó o
-- NULL si el SKU no existe). Si el SKU es un kit, la resta va a las piezas —p_unidades
-- kits × cantidad de cada pieza, en un solo UPDATE— y devuelve los kits que quedan.
create or replace function public.descontar_stock(p_sku text, p_unidades integer)
returns integer
language plpgsql
as $$
declare
  v_stock integer;
begin
  if exists (select 1 from kit_componentes where kit_sku = p_sku) then
    update productos c
       set stock_dep     = greatest(0, c.stock_dep - p_unidades * k.cantidad),
           stock_meli    = greatest(0, c.stock_dep - p_unidades * k.cantidad) / greatest(1, c.unidades_por_venta),
           stock_shopify = greatest(0, c.stock_dep - p_unidades * k.cantidad) / greatest(1, c.unidades_por_venta),
           updated_at    = now()
      from kit_componentes k
     where k.kit_sku = p_sku
       and c.sku = k.componente_sku;

    select stock_dep into v_stock from productos where sku = p_sku;
    return v_stock;
  end if;

  update productos
     set stock_dep     = greatest(0, stock_dep - p_unidades),
         stock_meli    = greatest(0, stock_dep - p_unidades) / greatest(1, unidades_por_venta),
         stock_shopify = greatest(0, stock_dep - p_unidades) / greatest(1, unidades_por_venta),
         updated_at    = now()
   where sku = p_sku
  returning stock_dep into v_stock;
  return v_stock;
end;
$$;

revoke all on function public.descontar_stock(text, integer) from public, anon, authenticated;
grant execute on function public.descontar_stock(text, integer) to service_role;
revoke all on function public.stock_kit(text) from public, anon, authenticated;
grant execute on function public.stock_kit(text) to service_role;
