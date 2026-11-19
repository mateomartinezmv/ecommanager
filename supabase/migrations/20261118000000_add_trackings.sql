-- Tracking de contenedores: dónde está cada contenedor y cuándo llega de verdad.
-- Feature: Importaciones → 🚢 Tracking
--
-- Cada PI se pide por separado y a cada importación se le calcula su llegada, pero el
-- importador junta varias PIs en un mismo contenedor y llegan todas juntas. El contenedor,
-- con lo que informa la naviera, es lo único que dice cuándo llega:
--
--   contenedor        número ISO 6346 normalizado (PCIU8919128); se muestra "PCIU 891912-8".
--   naviera           'PIL' se consulta sola en pilship.com (api/_pil.js, cron cada 4 horas);
--                     las demás se cargan a mano con link_seguimiento.
--   estado            reservado · origen · terminal · navegando · transbordo · en_puerto · retirado
--                     (public/tracking-contenedores.js lo deduce de los movimientos).
--   etd / eta         zarpe del puerto de origen y arribo estimado al de destino.
--   tramos, eventos   lo que devuelve la naviera: el resumen por tramo y cada movimiento
--                     [{fecha, hora, estimado, evento, lugar, buque, viaje}].
--   eta_historial     cada vez que cambió el arribo: [{eta, desde, fuente}].
--   importaciones     las PIs que viajan adentro: [{id, pi, descripcion, llegada_calculada}].
--                     llegada_calculada es la llegada que tenía la importación al sumarla al
--                     contenedor; después su `llegada` pasa a ser el arribo del contenedor.
--   consultado_at     última consulta a la naviera; consulta_error, si falló.
--
-- El id es TEXT ('TRK<timestamp>') igual que el de importaciones ('IMP<timestamp>').

create table if not exists trackings (
  id                text primary key,
  naviera           text not null default 'PIL',
  contenedor        text not null,
  link_seguimiento  text,
  buque             text,
  viaje             text,
  puerto_origen     text,
  puerto_destino    text default 'MONTEVIDEO',
  etd               date,
  eta               date,
  estado            text not null default 'reservado',
  tramos            jsonb not null default '[]'::jsonb,
  eventos           jsonb not null default '[]'::jsonb,
  eta_historial     jsonb not null default '[]'::jsonb,
  importaciones     jsonb not null default '[]'::jsonb,
  notas             text,
  consultado_at     timestamptz,
  consulta_error    text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Igual que el resto de las tablas: RLS prendido y sin políticas. La API usa la service key.
alter table trackings enable row level security;

create index if not exists trackings_estado_idx on trackings(estado);
create index if not exists trackings_contenedor_idx on trackings(contenedor);

comment on column trackings.importaciones is
  'PIs que viajan en el contenedor: [{id, pi, descripcion, llegada_calculada}]. La llegada de '
  'cada importación se actualiza al arribo (eta) del contenedor.';
comment on column trackings.eta_historial is
  'Cada cambio del arribo estimado: [{eta, desde, fuente}] (fuente: PIL o manual).';
