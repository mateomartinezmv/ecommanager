// api/meli/_cargosMeli.js
// "Cargos por venta" de MELI para una línea de una orden: lo que MELI se queda por vender,
// sin contar el envío (eso va aparte, ver _envioMeli.js).
//
// MELI nunca cobra $0 por vender, pero el CRM guardaba $0 cada tanto: cuando llega el aviso
// de la orden, el `sale_fee` del ítem puede venir vacío o en 0 y el pago no trae el neto
// (/payments da 404). Pasó en septiembre (comisión $0) y desde el 3/11, con el envío sumado
// aparte, la comisión quedaba igual al envío ($135 = $135, o −$33,80 en Flex).
//
// Por eso se prueba en orden, y la primera que da algo > 0 gana:
//   1. total − neto del pago aprobado (lo que realmente descontó MELI), prorrateado por línea
//   2. sale_fee del ítem (por unidad) × cantidad
//   3. marketplace_fee del pago aprobado, prorrateado por línea
//   4. /sites/{site}/listing_prices con el precio, el tipo de publicación y la categoría: es
//      la misma tabla que usa MELI para calcular el sale_fee
// Si ninguna da, devuelve 0 con fuente 'sin_dato' y el cron de sync-envios la vuelve a
// intentar (ver ventasSinCargos / recalcularSinCargos).

const num = v => (v === null || v === undefined ? 0 : parseFloat(v) || 0);
const r2 = v => Math.round(v * 100) / 100;

function pagoAprobado(order) {
  return (order?.payments || []).find(p => p.status === 'approved') || null;
}

function totalOrden(order) {
  return (order?.order_items || []).reduce((s, i) => s + num(i.unit_price) * num(i.quantity), 0);
}

/** total − neto del pago, si el neto está y es menor al total. */
function deduccionDelPago(order, netReceived) {
  const gross = totalOrden(order);
  const neto = num(netReceived ?? pagoAprobado(order)?.net_received_amount);
  return neto > 0 && neto < gross ? r2(gross - neto) : null;
}

/** Tarifa de venta por unidad según listing_prices. null si no se pudo leer. */
async function saleFeeDeListado(item, token, fetchImpl = fetch) {
  const precio = num(item?.unit_price);
  const tipo = item?.listing_type_id;
  const itemId = String(item?.item?.id || '');
  const site = (itemId.match(/^[A-Z]{3}/) || [])[0];
  if (!precio || !tipo || !site) return null;
  const qs = new URLSearchParams({ price: String(precio), listing_type_id: tipo });
  if (item.item?.category_id) qs.set('category_id', item.item.category_id);
  try {
    const r = await fetchImpl(`https://api.mercadolibre.com/sites/${site}/listing_prices?${qs}`, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    });
    if (!r.ok) return null;
    const data = await r.json();
    const lista = Array.isArray(data) ? data : [data];
    const fila = lista.find(x => x && x.listing_type_id === tipo) || lista[0];
    const fee = num(fila?.sale_fee_amount);
    return fee > 0 ? fee : null;
  } catch (_) {
    return null;
  }
}

/**
 * Cargos por venta de una línea de la orden.
 * @returns {{ cargos: number, saleFee: number, fuente: 'pago'|'sale_fee'|'marketplace_fee'|'listing_prices'|'sin_dato' }}
 *   saleFee es el sale_fee del ítem × cantidad (lo que necesita comisionConEnvio), o 0.
 */
async function cargosDeLinea({ order, item, token, netReceived, fetchImpl = fetch }) {
  const cantidad = num(item?.quantity) || 1;
  const lineaTotal = num(item?.unit_price) * cantidad;
  const gross = totalOrden(order) || lineaTotal || 1;
  const parte = lineaTotal / gross;
  const saleFee = r2(Math.abs(num(item?.sale_fee)) * cantidad);

  const deduccion = deduccionDelPago(order, netReceived);
  if (deduccion !== null) return { cargos: r2(deduccion * parte), saleFee, fuente: 'pago' };

  if (saleFee > 0) return { cargos: saleFee, saleFee, fuente: 'sale_fee' };

  const fee = Math.abs(num(pagoAprobado(order)?.marketplace_fee));
  if (fee > 0) return { cargos: r2(fee * parte), saleFee, fuente: 'marketplace_fee' };

  const porUnidad = await saleFeeDeListado(item, token, fetchImpl);
  if (porUnidad) return { cargos: r2(porUnidad * cantidad), saleFee: r2(porUnidad * cantidad), fuente: 'listing_prices' };

  return { cargos: 0, saleFee: 0, fuente: 'sin_dato' };
}

module.exports = { cargosDeLinea, saleFeeDeListado, deduccionDelPago, pagoAprobado };
