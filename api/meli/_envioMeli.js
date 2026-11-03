// api/meli/_envioMeli.js
// Lo que MELI le cobra al vendedor por un envío de Mercado Envíos, y cómo sumarlo a la comisión.
//
// Cuando la publicación tiene envío gratis, el comprador no paga el envío y MELI se lo cobra
// al vendedor; cuando no lo tiene, lo paga el comprador y al vendedor no le cuesta nada. El
// shipment lo dice con dos números de `shipping_option`:
//
//   · list_cost: lo que vale el envío.
//   · cost:      lo que pagó el comprador.
//
// La diferencia es lo que paga el vendedor, que es el "Envíos" que muestra el detalle de la
// venta en el panel de MELI. Medido sobre ventas reales (MLU, xd_drop_off):
//
//   envío gratis   → list_cost 135, cost 0   → vendedor paga $135 (panel: Envíos -$135)
//   paga comprador → list_cost 255, cost 255 → vendedor paga $0   (panel: Envíos $0)
//
// Antes se usaba `base_cost` (lo que le cuesta el envío a MELI, $270 en el primer caso: no
// es lo que paga el vendedor) y además se ponía en 0 todo `xd_drop_off`/`drop_off` asumiendo
// que ahí siempre paga el comprador. En Uruguay casi todo Mercado Envíos es drop_off, así que
// el envío de las publicaciones con envío gratis no se contaba en ningún lado.
//
// Ese cargo NO viene en el pago: `marketplace_fee` y `net_received_amount` del pago sólo
// tienen los "Cargos por venta" ($205,95 en el ejemplo); el envío MELI lo descuenta aparte.
// Por eso hay que sumarlo a mano a la comisión, que en el CRM es todo lo que MELI se queda.

// Flex: el envío lo hace un transportista propio y su costo va en la tabla envíos.
const FLEX_TYPES = ['self_service', 'self_service_flex'];

const num = v => (v === null || v === undefined ? 0 : parseFloat(v) || 0);
const r2 = v => Math.round(v * 100) / 100;

/** Lo que paga el vendedor por el envío entero (todo el paquete). 0 si no es Mercado Envíos. */
function envioPagadoPorVendedor(shipData) {
  if (!shipData || shipData.error) return 0;
  if (FLEX_TYPES.includes(shipData.logistic_type || '')) return 0;
  const opt = shipData.shipping_option || {};
  if (opt.list_cost === null || opt.list_cost === undefined) return 0;
  return r2(Math.max(0, num(opt.list_cost) - num(opt.cost)));
}

/**
 * La parte del envío que le toca a una línea de venta.
 *
 * Un envío puede cubrir varias órdenes (un carrito de MELI es un pack de órdenes con un solo
 * shipment). `order_cost` del shipment es el total de todo lo que viaja en el paquete; si se
 * repartiera sólo sobre la orden, cada orden del carrito se cargaría el envío entero.
 */
function envioDeLinea(shipData, lineaTotal, ordenTotal) {
  const envio = envioPagadoPorVendedor(shipData);
  if (envio <= 0) return 0;
  const base = Math.max(num(shipData?.order_cost), num(ordenTotal));
  if (base <= 0) return 0;
  return r2(envio * num(lineaTotal) / base);
}

/**
 * Comisión de la línea = cargos por venta + envío que paga el vendedor.
 *
 * `cargos` es lo que salió del pago (total − neto, o sale_fee). Si alguna vez MELI ya trae el
 * envío adentro del neto, la deducción da exactamente cargos por venta + envío: en ese caso
 * no se vuelve a sumar.
 */
function comisionConEnvio({ cargos, saleFee, envio }) {
  const c = num(cargos);
  const e = num(envio);
  if (e <= 0) return r2(c);
  const yaIncluido = num(saleFee) > 0 && Math.abs(c - (num(saleFee) + e)) < 1;
  return r2(yaIncluido ? c : c + e);
}

module.exports = { envioPagadoPorVendedor, envioDeLinea, comisionConEnvio, FLEX_TYPES };
