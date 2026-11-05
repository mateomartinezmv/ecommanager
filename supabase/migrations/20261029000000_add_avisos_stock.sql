-- Waitlist: clientes que esperan que vuelva a entrar un producto.
-- Feature: Clientes → 🔔 Avisar cuando vuelva / Stock → 🔔 Waitlist
--
-- Cuando un producto se queda sin stock y un cliente lo pide, se anota acá el cliente y el
-- SKU. El aviso NO se dispara con cualquier movimiento de stock (un ajuste a mano, una
-- devolución o una venta cancelada también suben el número): se dispara cuando llega una
-- importación que trae ese SKU, que es cuando de verdad "volvió". Lo hace
-- /api/importaciones al pasar una importación a recibida (ver api/_avisosStock.js).
--
-- Estados:
--   esperando → el cliente lo pidió y todavía no llegó ninguna importación con el SKU.
--   listo     → llegó la importación (importacion_id); falta mandarle el WhatsApp.
--   avisado   → se le mandó el WhatsApp desde la pestaña Waitlist.
--   cancelado → ya no lo quiere, se lo consiguió en otro lado, se cargó por error.
--
-- El id es TEXT ('AVI<timestamp>') igual que clientes ('CLI…') e importaciones ('IMP…').
-- sku no lleva FK a productos a propósito: borrar un producto no tiene que borrar el
-- historial de quién lo pidió, y la pantalla ya muestra el SKU suelto si no lo encuentra.

CREATE TABLE IF NOT EXISTS avisos_stock (
  id              TEXT PRIMARY KEY,
  cliente_id      TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  sku             TEXT NOT NULL,
  cantidad        INTEGER NOT NULL DEFAULT 1 CHECK (cantidad >= 1),
  nota            TEXT,
  estado          TEXT NOT NULL DEFAULT 'esperando'
                  CHECK (estado IN ('esperando', 'listo', 'avisado', 'cancelado')),
  importacion_id  TEXT,                 -- la importación que lo trajo (al pasar a 'listo')
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  listo_at        TIMESTAMPTZ,
  avisado_at      TIMESTAMPTZ
);

-- Igual que el resto de las tablas: RLS prendido y sin políticas. La API escribe con la
-- service key (que lo saltea); la anon key no puede leer teléfonos de clientes.
ALTER TABLE avisos_stock ENABLE ROW LEVEL SECURITY;

-- La llegada de una importación busca por SKU entre los que siguen esperando.
CREATE INDEX IF NOT EXISTS avisos_stock_sku_estado_idx ON avisos_stock(sku, estado);
CREATE INDEX IF NOT EXISTS avisos_stock_cliente_idx    ON avisos_stock(cliente_id);

-- Un cliente no puede estar dos veces en la lista del mismo SKU mientras el aviso siga
-- abierto: el segundo WhatsApp sería el mismo mensaje. Avisados y cancelados no cuentan,
-- así el mismo cliente puede volver a anotarse la próxima vez que se agote.
CREATE UNIQUE INDEX IF NOT EXISTS avisos_stock_abierto_unico
  ON avisos_stock(cliente_id, sku)
  WHERE estado IN ('esperando', 'listo');

COMMENT ON TABLE avisos_stock IS
  'Waitlist: clientes que esperan que vuelva a entrar un SKU. Pasan a listo cuando llega '
  'una importación que lo trae (api/_avisosStock.js).';
COMMENT ON COLUMN avisos_stock.importacion_id IS
  'Importación cuya llegada pasó el aviso a listo. NULL mientras está esperando.';
