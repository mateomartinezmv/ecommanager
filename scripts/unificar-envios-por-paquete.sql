-- scripts/unificar-envios-por-paquete.sql
--
-- Arrastre del bug "un envío por ítem": los carritos de MELI llegan como varias
-- órdenes bajo un mismo pack y un único paquete, pero el CRM registró un envío
-- por cada una. Resultado: el flete contado dos y tres veces.
--
-- Este script deja UN envío por paquete, consolidando lo que había:
--   · producto        → todo lo que entra en la caja
--   · costo           → el mayor de los cargados (es un solo flete, no la suma)
--   · colecta/pagado  → si estaba marcado en alguno, queda marcado
--   · tracking/fecha  → el que estuviera cargado
-- Sobrevive el envío más trabajado a mano (colecta, pagado, transportista
-- cambiado, tracking); a igualdad, el más viejo.
--
-- Corre una sola vez. Es idempotente: si ya no hay paquetes con más de un
-- envío, no toca nada.

begin;

create temp table envios_paquete on commit drop as
select coalesce(pack_id, orden) as paquete, *
from envios
where id like 'E_MELI_%' and coalesce(pack_id, orden) is not null;

create temp table paquetes_dup on commit drop as
select paquete from envios_paquete group by paquete having count(*) > 1;

create temp table sobrevivientes on commit drop as
select distinct on (p.paquete) p.paquete, p.id
from envios_paquete p join paquetes_dup d using (paquete)
order by p.paquete,
         (p.colecta)::int + (p.pagado)::int
           + (p.transportista not in ('mercado_envios', 'enviosuy'))::int
           + (p.tracking is not null)::int desc,
         p.created_at asc;

-- Lo que viaja en el paquete: todas las líneas de venta del carrito, hayan
-- tenido envío propio o no.
create temp table contenido on commit drop as
select paquete,
       string_agg(producto || ' x' || cantidad, ' + ' order by id) as producto,
       min(id) as primera_venta
from (
  select distinct s.paquete, v.id, v.producto, v.cantidad
  from sobrevivientes s
  join ventas v on v.pack_id = s.paquete or v.orden_meli = s.paquete
) lineas
group by paquete;

create temp table consolidado on commit drop as
select s.paquete, s.id,
       max(p.costo) as costo,
       bool_or(coalesce(p.colecta, false)) as colecta,
       bool_or(coalesce(p.pagado, false)) as pagado,
       max(p.tracking) as tracking,
       min(p.fecha_despacho) as fecha_despacho
from sobrevivientes s join envios_paquete p using (paquete)
group by s.paquete, s.id;

update envios e
set producto = coalesce(c.producto, e.producto),
    venta_id = coalesce(c.primera_venta, e.venta_id),
    pack_id = coalesce(e.pack_id, cs.paquete),
    costo = cs.costo,
    colecta = cs.colecta,
    pagado = cs.pagado,
    tracking = coalesce(e.tracking, cs.tracking),
    fecha_despacho = coalesce(e.fecha_despacho, cs.fecha_despacho)
from consolidado cs
left join contenido c using (paquete)
where e.id = cs.id;

delete from envios e
using envios_paquete p
where e.id = p.id
  and p.paquete in (select paquete from paquetes_dup)
  and e.id not in (select id from sobrevivientes);

commit;
