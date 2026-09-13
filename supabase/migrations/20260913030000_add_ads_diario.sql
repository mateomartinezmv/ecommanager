-- Gasto diario de Mercado Ads, un registro por día.
--
-- Reemplaza a meli_ads_gastos, que guardaba el total del período consultado bajo la fecha
-- de inicio de ese período: cada consulta con un rango distinto creaba una fila que ya
-- incluía a las anteriores, así que la tabla no se podía sumar sin contar dos veces.
--
-- La API de MELI expone métricas con aggregation_type=DAILY, que devuelve un registro por
-- día con el gasto real de ese día. Al estar la fecha como clave primaria, volver a pedir
-- un rango pisa los mismos registros en lugar de acumular: la captura es repetible.
--
-- DAILY agrega a nivel cuenta y no discrimina campaña, así que acá no hay campaign_id.
-- Para el costo del negocio alcanza; el detalle por campaña se consulta en vivo contra MELI.
CREATE TABLE IF NOT EXISTS meli_ads_diario (
  fecha        DATE PRIMARY KEY,
  spend        NUMERIC(12,2) NOT NULL DEFAULT 0,
  clicks       INTEGER       NOT NULL DEFAULT 0,
  impressions  INTEGER       NOT NULL DEFAULT 0,
  facturacion  NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency     TEXT          NOT NULL DEFAULT 'UYU',
  fetched_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE meli_ads_diario IS
  'Gasto diario de Mercado Ads (aggregation_type=DAILY). Una fila por día, sumable.';
COMMENT ON COLUMN meli_ads_diario.facturacion IS
  'total_amount de MELI: facturación atribuida a Ads (directa + indirecta).';

-- La tabla vieja no se borra: MELI sólo sirve 90 días de métricas hacia atrás, así que sus
-- snapshots son el único registro que queda del gasto anterior a esa ventana. Se renombra
-- para que ningún código la siga tomando por buena.
ALTER TABLE IF EXISTS meli_ads_gastos RENAME TO meli_ads_snapshots_legacy;

COMMENT ON TABLE meli_ads_snapshots_legacy IS
  'Histórico. Cada fila es el acumulado del período consultado, no el gasto de esa fecha: '
  'NO SUMAR. Se conserva sólo como referencia del gasto anterior a la ventana de 90 días.';
