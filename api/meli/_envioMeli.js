// api/meli/_envioMeli.js
// Lo que el envío le suma o le resta a lo que MELI se queda de una venta.
//
// La fuente es GET /shipments/{id}/costs, que dice qué paga cada parte. Del vendedor
// (`senders[0]`) importan tres números, y no significan lo mismo en Mercado Envíos que en Flex.
// Medido contra el panel de MELI en ventas reales (MLU, 2/11):
//
//   Mercado Envíos, envío gratis   cost 135   save 135   → panel: Envíos −$135
//   Mercado Envíos, paga comprador cost 0                → panel: Envíos $0
//   Flex, envío gratis             cost 135,2 save 33,8  charge_flex 0
//                                                        → panel: Anulaciones de cargos +$33,80
//   Flex, paga comprador           cost 0     save 0     → sin bonificación
//
//   · Mercado Envíos: el vendedor paga `cost`. El `save` es el descuento que MELI aplica sobre
//     la tarifa entera ($270 → $135): ya está descontado de `cost`, no es plata que vuelve.
//   · Flex: el envío lo hace el vendedor, así que `cost` no se cobra (lo que se cobra es
//     `charges.charge_flex`), y `save` es la bonificación por envío que MELI le devuelve al
//     vendedor como "Anulación de cargos".
//
// Nada de esto viene en el pago (que además la API no deja leer: /payments da 404), así que la
// comisión del CRM, que es todo lo que MELI se queda, se arma a mano:
//   comision = cargos por venta + cobro de envío − bonificación de envío
// y la parte de envío queda desglosada en `ventas.costo_envio_meli`, con signo: positivo es
// un cobro, negativo una bonificación.
//
// Si /costs no responde se cae al shipment: en Mercado Envíos list_cost − cost da lo mismo que
// `cost`; en Flex con envío gratis, base_cost − list_cost da la bonificación ($169 − $135,2).

const FLEX_TYPES = ['self_service', 'self_service_flex'];

const num = v => (v === null || v === undefined ? 0 : parseFloat(v) || 0);
const r2 = v => Math.round(v * 100) / 100;

function remitente(shipData, costs) {
  const senders = Array.isArray(costs?.senders) ? costs.senders : [];
  if (!senders.length) return null;
  return senders.find(s => String(s.user_id) === String(shipData?.sender_id)) || senders[0];
}

/**
 * Cuánto mueve el envío entero (todo el paquete) en lo que MELI se queda.
 * > 0: MELI le cobra al vendedor el envío. < 0: MELI le bonifica el envío. 0: ninguno.
 */
function ajusteEnvio(shipData, costs) {
  if (!shipData || shipData.error) return 0;
  const esFlex = FLEX_TYPES.includes(shipData.logistic_type || '');
  const s = remitente(shipData, costs);
  const opt = shipData.shipping_option || {};

  if (esFlex) {
    if (s) return r2(num(s.charges?.charge_flex) - num(s.save));
    const gratis = opt.cost !== null && opt.cost !== undefined && num(opt.cost) === 0;
    return gratis ? -r2(Math.max(0, num(shipData.base_cost) - num(opt.list_cost))) : 0;
  }

  if (s) return r2(Math.max(0, num(s.cost)));
  if (opt.list_cost === null || opt.list_cost === undefined) return 0;
  return r2(Math.max(0, num(opt.list_cost) - num(opt.cost)));
}

/**
 * La parte del ajuste de envío que le toca a una línea de venta.
 *
 * Un envío puede cubrir varias órdenes (un carrito de MELI es un pack de órdenes con un solo
 * shipment). `order_cost` del shipment es el total de todo lo que viaja en el paquete; si se
 * repartiera sólo sobre la orden, cada orden del carrito se cargaría el envío entero.
 */
function envioDeLinea(shipData, costs, lineaTotal, ordenTotal) {
  const ajuste = ajusteEnvio(shipData, costs);
  if (ajuste === 0) return 0;
  const base = Math.max(num(shipData?.order_cost), num(ordenTotal));
  if (base <= 0) return 0;
  return r2(ajuste * num(lineaTotal) / base);
}

/**
 * Comisión de la línea = cargos por venta + ajuste de envío (cobro o bonificación).
 *
 * `cargos` es lo que salió del pago (total − neto) o el sale_fee. Si alguna vez MELI ya trae
 * el cobro de envío adentro del neto, la deducción da exactamente cargos por venta + envío: en
 * ese caso no se vuelve a sumar. Nunca baja de 0.
 */
function comisionConEnvio({ cargos, saleFee, envio }) {
  const c = num(cargos);
  const e = num(envio);
  if (e === 0) return r2(c);
  const yaIncluido = e > 0 && num(saleFee) > 0 && Math.abs(c - (num(saleFee) + e)) < 1;
  return r2(Math.max(0, yaIncluido ? c : c + e));
}

/** GET /shipments/{id}/costs. No lanza: sin costs, ajusteEnvio usa el shipment. */
async function leerCostosEnvio(shippingId, token) {
  if (!shippingId) return null;
  try {
    const r = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}/costs`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

module.exports = { ajusteEnvio, envioDeLinea, comisionConEnvio, leerCostosEnvio, FLEX_TYPES };
