-- Descatalogar un producto con un motivo, no sólo con un flag.
-- Feature: Stock → ⛔ Descatalogar / Discontinuados
--
-- `discontinuado` ya existía como booleano y hacía una sola cosa: sacar al producto de
-- reposición, de los avisos de stock bajo y de la sincronización masiva de stock. Lo que no
-- quedaba en ninguna parte era POR QUÉ se descatalogó, y ese es el dato que sirve para
-- decidir qué volver a importar: si tres de los cuatro productos de un subgrupo se cayeron
-- por poca venta, el problema es el subgrupo, no el producto.
--
-- Tres columnas nuevas:
--   motivo_discontinuado → slug del motivo (ver abajo). NULL = descatalogado antes de esta
--                          migración, sin motivo registrado.
--   nota_discontinuado   → aclaración libre opcional ("el proveedor cambió el diámetro").
--   fecha_discontinuado  → cuándo se descatalogó, para poder mirarlo por período.
--
-- El motivo es TEXT y no un ENUM ni una FK a propósito: el catálogo vive en un solo lugar
-- del código (api/_discontinuado.js, espejado en public/index.html) y agregar un motivo
-- nuevo no tiene que costar una migración. La API valida contra ese catálogo antes de
-- escribir, así que a la columna no entra cualquier cosa.
--
-- Motivos del catálogo al momento de esta migración:
--   poca_venta     → Poca venta / rotación baja
--   poco_margen    → Poco margen de ganancia
--   problematico   → Producto problemático (calidad, reclamos, devoluciones)
--   sin_proveedor  → No se consigue más / el proveedor lo discontinuó
--   reemplazado    → Reemplazado por otra versión o modelo
--   competencia    → No competitivo en precio
--   otro           → Otro motivo (se espera que venga con nota)

ALTER TABLE productos ADD COLUMN IF NOT EXISTS motivo_discontinuado TEXT;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS nota_discontinuado   TEXT;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS fecha_discontinuado  DATE;

-- Índice parcial: las consultas de análisis siempre miran el subconjunto descatalogado,
-- que es chico contra el catálogo entero.
CREATE INDEX IF NOT EXISTS productos_discontinuado_motivo_idx
  ON productos(motivo_discontinuado)
  WHERE discontinuado = TRUE;

COMMENT ON COLUMN productos.motivo_discontinuado IS
  'Slug del motivo por el que se descatalogó (poca_venta, poco_margen, problematico, '
  'sin_proveedor, reemplazado, competencia, otro). NULL si se descatalogó antes de que '
  'existiera el campo. El catálogo válido vive en api/_discontinuado.js.';
COMMENT ON COLUMN productos.nota_discontinuado IS
  'Aclaración libre del motivo, opcional. Lo normal es que la traigan los motivos "otro".';
COMMENT ON COLUMN productos.fecha_discontinuado IS
  'Fecha en la que se descatalogó. Se limpia al reactivar el producto.';

-- Los productos que ya estaban descatalogados quedan con motivo y fecha en NULL. No se les
-- inventa una fecha (created_at es la de alta, no la del descatalogado, y CURRENT_DATE
-- mentiría sobre cuándo se dejó de comprar): la pantalla los muestra como "sin motivo
-- registrado" y se les puede poner el motivo a mano desde Stock → ⛔ Discontinuados.
