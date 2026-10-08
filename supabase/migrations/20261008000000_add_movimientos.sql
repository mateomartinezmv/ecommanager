-- Otros gastos y otros ingresos del negocio: lo que no entra por una venta ni es un costo
-- fijo mensual. El packaging que se compra de una, el envío que se paga por un cambio o una
-- devolución, los rendimientos de la cuenta de Mercado Pago, un reintegro de MELI.
--
-- Por qué una tabla aparte y no costos fijos: los costos fijos (que viven en localStorage)
-- son una suscripción mensual que se prorratea por período. Esto son movimientos puntuales
-- con fecha propia, así que se suman sólo en el período en el que cayeron, igual que una
-- venta o un envío.
--
-- Las categorías ("Envíos", "Packaging", "Rendimientos MP") son una tabla y no un enum para
-- que se puedan agregar desde la UI sin migrar la base.

CREATE TABLE IF NOT EXISTS movimiento_categorias (
  id          TEXT PRIMARY KEY,                -- slug: 'envios', 'packaging'
  nombre      TEXT NOT NULL,
  -- 'gasto' y 'ingreso' restringen en qué formulario aparece la categoría; 'ambos' sirve a
  -- los dos lados (ej. "Envíos": se paga un cambio, pero también puede entrar un reintegro).
  tipo        TEXT NOT NULL DEFAULT 'ambos' CHECK (tipo IN ('gasto', 'ingreso', 'ambos')),
  color       TEXT NOT NULL DEFAULT '#64748b', -- color de la porción en el gráfico circular
  orden       INTEGER NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS movimientos (
  id            TEXT PRIMARY KEY,              -- 'MOV-<timestamp>'
  tipo          TEXT NOT NULL CHECK (tipo IN ('gasto', 'ingreso')),
  fecha         DATE NOT NULL,
  categoria_id  TEXT REFERENCES movimiento_categorias(id) ON DELETE SET NULL,
  concepto      TEXT NOT NULL,
  monto         NUMERIC(12,2) NOT NULL CHECK (monto >= 0),
  moneda        TEXT NOT NULL DEFAULT 'UYU' CHECK (moneda IN ('UYU', 'USD')),
  -- Cotización usada al cargar el movimiento, no la de hoy: un gasto en USD de hace seis
  -- meses tiene que seguir valiendo los pesos que costó entonces. NULL cuando es en UYU.
  cotizacion    NUMERIC(10,2),
  -- Monto ya convertido a pesos. Se guarda calculado para que los reportes sumen una sola
  -- columna y el histórico no se mueva cuando cambia el tipo de cambio.
  monto_uyu     NUMERIC(12,2) NOT NULL CHECK (monto_uyu >= 0),
  -- Sólo para ingresos: si este ingreso se factura, computa contra el tope del Literal E.
  -- Arranca en false porque lo típico (rendimientos de Mercado Pago) no es facturación por
  -- venta de bienes.
  cuenta_facturacion BOOLEAN NOT NULL DEFAULT FALSE,
  venta_id      TEXT,                          -- opcional: la venta que originó el movimiento
  notas         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS movimientos_fecha     ON movimientos(fecha DESC);
CREATE INDEX IF NOT EXISTS movimientos_tipo      ON movimientos(tipo, fecha DESC);
CREATE INDEX IF NOT EXISTS movimientos_categoria ON movimientos(categoria_id);

COMMENT ON TABLE movimientos IS
  'Gastos e ingresos que no vienen de una venta ni son costo fijo mensual. Se suman a la '
  'ganancia neta del período en Reportes.';
COMMENT ON COLUMN movimientos.monto_uyu IS
  'monto convertido a pesos con la cotización del día de carga. Es la columna que suman los reportes.';
COMMENT ON COLUMN movimientos.cuenta_facturacion IS
  'TRUE si el ingreso se factura y por lo tanto computa contra el tope del Literal E.';

-- Categorías de arranque. ON CONFLICT para que correr la migración dos veces no falle ni
-- pise los nombres o colores que el usuario haya editado.
INSERT INTO movimiento_categorias (id, nombre, tipo, color, orden) VALUES
  ('envios',       'Envíos',                  'ambos',   '#ef4444', 10),
  ('packaging',    'Packaging',               'gasto',   '#f59e0b', 20),
  ('devoluciones', 'Cambios y devoluciones',  'ambos',   '#f97316', 30),
  ('herramientas', 'Herramientas y servicios','gasto',   '#8b5cf6', 40),
  ('impuestos',    'Impuestos y tasas',       'gasto',   '#64748b', 50),
  ('otros_gastos', 'Otros gastos',            'gasto',   '#94a3b8', 60),
  ('rendimientos', 'Rendimientos Mercado Pago','ingreso','#22c55e', 70),
  ('reintegros',   'Reintegros y bonificaciones','ingreso','#14b8a6', 80),
  ('otros_ingresos','Otros ingresos',         'ingreso', '#4f8ef7', 90)
ON CONFLICT (id) DO NOTHING;
