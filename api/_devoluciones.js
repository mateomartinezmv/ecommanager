// api/_devoluciones.js
// Reglas de las devoluciones que no son mover stock:
//  · el costo de envío (lo que se paga para que el producto vuelva desde la dirección del
//    cliente hasta el depósito);
//  · el producto equivocado: el cliente pidió A (sku de la venta), le llegó B
//    (sku_recibido) y devuelve B. El stock que se mueve es siempre el de B.

const MIGRACION_COSTO_ENVIO = '20261104000000_add_costo_envio_devoluciones.sql';
const MIGRACION_SKU_RECIBIDO = '20261105000000_add_sku_recibido_devoluciones.sql';

// El SKU cuyo stock mueve la devolución: el que le llegó al cliente si fue uno equivocado,
// si no el de la venta.
function skuDeStock(dev) {
  return (dev && dev.sku_recibido) || (dev && dev.sku);
}

// ¿El error es "las columnas del producto equivocado no existen"? (deploy antes que la migración)
function faltaMigracionSkuRecibido(error) {
  if (!error) return false;
  const msg = String(error.message || '');
  return /sku_recibido|producto_recibido/i.test(msg) && (['PGRST204', '42703'].includes(error.code) || /column|columna|schema/i.test(msg));
}

// "350", "350,50", 350 → 350.5 redondeado a centavos. Vacío/null → 0 (sin costo).
// Devuelve null si no es un monto válido (negativo, texto).
function normalizarCostoEnvio(valor) {
  if (valor === undefined || valor === null || valor === '') return 0;
  const n = typeof valor === 'number' ? valor : Number(String(valor).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

// ¿El error es "la columna costo_envio no existe"? Pasa cuando el deploy llega antes que la
// migración. PostgREST devuelve PGRST204 (columna desconocida en un write); 42703 es el mismo
// error subiendo crudo de Postgres.
function faltaMigracionCostoEnvio(error) {
  if (!error) return false;
  const msg = String(error.message || '');
  if (['PGRST204', '42703'].includes(error.code)) return /costo_envio/i.test(msg) || !msg;
  return /costo_envio/i.test(msg) && /column|columna|schema/i.test(msg);
}

module.exports = {
  MIGRACION_COSTO_ENVIO, normalizarCostoEnvio, faltaMigracionCostoEnvio,
  MIGRACION_SKU_RECIBIDO, skuDeStock, faltaMigracionSkuRecibido,
};
