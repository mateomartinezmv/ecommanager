-- =============================================
-- ECOMMANAGER — Schema Supabase
-- Ejecutar en: Supabase → SQL Editor → New query
-- =============================================

-- Tabla: productos
create table if not exists productos (
  id uuid default gen_random_uuid() primary key,
  sku text unique not null,
  nombre text not null,
  categoria text,
  stock_dep integer default 0,
  stock_meli integer default 0,
  costo numeric(12,2) default 0,
  precio numeric(12,2) not null,
  alerta_min integer default 5,
  meli_id text,
  notas text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Tabla: ventas
create table if not exists ventas (
  id text primary key,
  canal text not null check (canal in ('meli','mostrador')),
  fecha date not null,
  orden_meli text,
  comprador text,
  cliente text,
  sku text references productos(sku) on update cascade,
  producto text not null,
  cantidad integer not null,
  precio_unit numeric(12,2) not null,
  comision numeric(12,2) default 0,
  total numeric(12,2) not null,
  estado text default 'pagada',
  metodo_pago text,
  genera_envio boolean default false,
  notas text,
  created_at timestamptz default now()
);

-- Tabla: envios
create table if not exists envios (
  id text primary key,
  venta_id text references ventas(id),
  orden text,
  comprador text,
  producto text,
  transportista text,
  tracking text,
  fecha_despacho date,
  estado text default 'pendiente',
  direccion text,
  created_at timestamptz default now()
);

-- Tabla: meli_tokens (guarda el token OAuth de MELI)
create table if not exists meli_tokens (
  id integer primary key default 1,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  meli_user_id text,
  updated_at timestamptz default now()
);

-- Función para actualizar updated_at automáticamente
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger productos_updated_at
  before update on productos
  for each row execute function update_updated_at();

-- RLS: deshabilitar para simplificar (la seguridad la maneja la service key del backend)
alter table productos disable row level security;
alter table ventas disable row level security;
alter table envios disable row level security;
alter table meli_tokens disable row level security;
