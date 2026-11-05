-- Proveedores (importadores) y de cuál sale cada importación y cada producto.
-- Feature: Importaciones → 🏭 Proveedores y 🛒 Compras por proveedor
--
-- Cada importador pide un mínimo de compra en China (hoy USD 300 de costo de fábrica, sin
-- flete ni nacionalización) para aceptar un pedido. Hasta ahora las importaciones no
-- guardaban a quién se le compraba —a lo sumo quedaba escrito en las notas—, así que no había
-- forma de juntar lo que hay que reponer de un mismo importador y ver si llega al mínimo.
--
-- Una tabla y dos columnas:
--   proveedores                → los datos de contacto y el mínimo de compra de cada uno.
--   importaciones.proveedor_id → a quién se le hizo esa compra. NULL en las importaciones
--                                cargadas antes de esta migración; se les puede poner desde
--                                el ✏️ Editar de cada una.
--   productos.proveedor_id     → a quién se le compra hoy ese producto. La API lo completa
--                                sola con el proveedor de la importación más reciente que
--                                trae el SKU, y se puede asignar a mano desde 🏭 Proveedores.
--
-- El id es TEXT ('PROV-<timestamp>') igual que el de importaciones ('IMP<timestamp>').
-- ON DELETE SET NULL: borrar un proveedor no puede llevarse puestas las importaciones ni los
-- productos, sólo los deja sin asignar.

CREATE TABLE IF NOT EXISTS proveedores (
  id          TEXT PRIMARY KEY,
  nombre      TEXT NOT NULL,
  contacto    TEXT,                 -- persona con la que se habla
  telefono    TEXT,                 -- teléfono / WhatsApp
  wechat      TEXT,
  email       TEXT,
  ubicacion   TEXT,                 -- ciudad, país o dirección del depósito
  web         TEXT,                 -- tienda de Alibaba / 1688 / sitio propio
  -- Mínimo de compra en USD sobre el costo en China (lo que se declara por unidad en cada
  -- importación), no sobre el total pagado con flete e IVA.
  minimo_usd  NUMERIC(12,2) NOT NULL DEFAULT 300 CHECK (minimo_usd >= 0),
  notas       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Igual que el resto de las tablas: RLS prendido y sin políticas. La API escribe con la
-- service key (que lo saltea); la anon key no puede leer los contactos de los proveedores.
ALTER TABLE proveedores ENABLE ROW LEVEL SECURITY;

ALTER TABLE importaciones ADD COLUMN IF NOT EXISTS proveedor_id TEXT
  REFERENCES proveedores(id) ON DELETE SET NULL;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS proveedor_id TEXT
  REFERENCES proveedores(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS importaciones_proveedor_idx ON importaciones(proveedor_id);
CREATE INDEX IF NOT EXISTS productos_proveedor_idx     ON productos(proveedor_id);

COMMENT ON COLUMN proveedores.minimo_usd IS
  'Compra mínima que acepta el importador, en USD de costo en China (cantidad × costo '
  'unitario declarado). Por defecto 300.';
COMMENT ON COLUMN importaciones.proveedor_id IS
  'Importador al que se le hizo la compra. NULL en las importaciones anteriores al campo.';
COMMENT ON COLUMN productos.proveedor_id IS
  'Importador al que se le compra hoy el producto. Lo actualiza la API con el de la '
  'importación más reciente que trae el SKU; también se asigna a mano.';
