// api/_meliEnvios.js
// Traduce el estado real de un shipment de MELI al estado que usa el CRM y lo
// aplica sobre la tabla `envios`.
//
// Lo usan el webhook (api/meli/notify.js) y la reconciliación periódica
// (api/meli/sync-envios.js), así que la regla de traducción vive en un solo lugar.

'use strict';

// Estados del CRM ordenados por avance. La sincronización sólo va hacia adelante:
// si alguien corrigió un envío a mano, un estado viejo de MELI no lo pisa.
// `problema` no avanza a nadie (rango 0), pero sí puede ser superado por
// `en_camino` o `entregado` cuando el envío se destraba.
const RANGO_ESTADO = { pendiente: 0, problema: 0, en_camino: 1, entregado: 2 };

// Con cross-docking (drop off / agencia) MELI mantiene el status en
// `ready_to_ship` mientras el paquete ya está viajando: ahí lo que manda es el
// substatus. Con Flex y Full, en cambio, pasa directo a `shipped`.
const SUBSTATUS_EN_CAMINO = new Set([
  'picked_up',
  'authorized_by_carrier',
  'in_hub',
  'in_transit',
  'dropped_off',
  'rejected_in_hub',
  'out_for_delivery',
]);

// Devuelve el estado del CRM, o null si el status de MELI no dice nada útil
// (to_be_agreed, not_verified, closed, error…): en ese caso no se toca el envío.
function estadoDesdeShipment(shipment) {
  const status = shipment?.status || '';
  const substatus = shipment?.substatus || '';

  switch (status) {
    case 'delivered':
      return 'entregado';
    case 'shipped':
    case 'stale_shipped':
      return 'en_camino';
    case 'ready_to_ship':
    case 'stale_ready_to_ship':
      return SUBSTATUS_EN_CAMINO.has(substatus) ? 'en_camino' : 'pendiente';
    case 'pending':
    case 'handling':
      return 'pendiente';
    case 'not_delivered':
    case 'cancelled':
      return 'problema';
    default:
      return null;
  }
}

// Fecha en que el paquete salió, según el status_history de MELI.
function fechaDespachoDesdeShipment(shipment) {
  const h = shipment?.status_history || {};
  if (h.date_shipped) return String(h.date_shipped).slice(0, 10);

  // Con cross-docking no hay date_shipped: el paquete viaja con status
  // ready_to_ship. Ahí sirve la fecha de la etiqueta, pero sólo si ya salió —
  // una etiqueta impresa sin despachar todavía es un paquete en el depósito.
  const estado = estadoDesdeShipment(shipment);
  if (estado === 'en_camino' || estado === 'entregado') {
    const fecha = h.date_first_printed || h.date_ready_to_ship;
    if (fecha) return String(fecha).slice(0, 10);
  }
  return null;
}

// Calcula qué campos hay que tocar de un envío. Devuelve null si no cambia nada.
function cambiosParaEnvio(envio, shipment) {
  const update = {};

  const estadoNuevo = estadoDesdeShipment(shipment);
  if (estadoNuevo && estadoNuevo !== envio.estado) {
    if (estadoNuevo === 'problema') {
      // `problema` no avanza en la escala, pero avisa de algo que el CRM no
      // sabe: se aplica salvo que el envío ya haya llegado.
      if (envio.estado !== 'entregado') update.estado = 'problema';
    } else if (RANGO_ESTADO[estadoNuevo] > (RANGO_ESTADO[envio.estado] ?? 0)) {
      update.estado = estadoNuevo;
    }
  }

  const tracking = shipment?.tracking_number || null;
  if (tracking && !envio.tracking) update.tracking = tracking;

  const fechaDespacho = fechaDespachoDesdeShipment(shipment);
  if (fechaDespacho && !envio.fecha_despacho) update.fecha_despacho = fechaDespacho;

  return Object.keys(update).length ? update : null;
}

// Aplica el shipment sobre TODOS los envíos de una orden. Una orden con varios
// ítems genera un envío por ítem, así que acá no se puede usar .single().
async function sincronizarEnviosDeOrden(supabase, orden, shipment, { dryRun = false } = {}) {
  const { data: envios, error } = await supabase
    .from('envios')
    .select('id, estado, tracking, fecha_despacho')
    .eq('orden', String(orden));

  if (error) throw new Error(`Error leyendo envíos de la orden ${orden}: ${error.message}`);
  if (!envios || envios.length === 0) return [];

  const aplicados = [];
  for (const envio of envios) {
    const update = cambiosParaEnvio(envio, shipment);
    if (!update) continue;

    if (!dryRun) {
      const { error: updErr } = await supabase.from('envios').update(update).eq('id', envio.id);
      if (updErr) throw new Error(`Error actualizando ${envio.id}: ${updErr.message}`);
    }
    aplicados.push({ id: envio.id, estadoAnterior: envio.estado, ...update });
  }
  return aplicados;
}

async function meliFetch(token, url, headers = {}) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
  });
  return res.json();
}

// Órdenes cubiertas por un shipment.
// MELI dejó de devolver `order_id` dentro del shipment (deprecado en octubre de
// 2025), así que la fuente principal es /shipments/:id/orders — que además
// resuelve los carritos, donde un mismo envío agrupa varias órdenes.
async function ordenesDelShipment(token, shipmentId, shipment) {
  const ordenes = new Set();

  try {
    const data = await meliFetch(
      token,
      `https://api.mercadolibre.com/shipments/${shipmentId}/orders`,
      { 'X-New-Domain': 'true' }
    );
    if (Array.isArray(data)) {
      for (const o of data) if (o?.order_id) ordenes.add(String(o.order_id));
    }
  } catch (e) {
    console.error(`⚠ /shipments/${shipmentId}/orders falló: ${e.message}`);
  }

  if (shipment?.order_id) ordenes.add(String(shipment.order_id));

  return [...ordenes];
}

// Shipment de una orden. `order.shipping.id` es el camino directo; el endpoint
// /orders/:id/shipments queda como respaldo para cuando el JSON de órdenes deje
// de traer datos de envío.
async function shipmentIdDeOrden(token, ordenId) {
  const order = await meliFetch(token, `https://api.mercadolibre.com/orders/${ordenId}`);
  if (order?.shipping?.id) return String(order.shipping.id);

  const ship = await meliFetch(token, `https://api.mercadolibre.com/orders/${ordenId}/shipments`);
  if (ship?.id) return String(ship.id);
  if (Array.isArray(ship) && ship[0]?.id) return String(ship[0].id);

  return null;
}

async function obtenerShipment(token, shipmentId) {
  const shipment = await meliFetch(token, `https://api.mercadolibre.com/shipments/${shipmentId}`);
  if (!shipment || shipment.error) return null;
  return shipment;
}

module.exports = {
  RANGO_ESTADO,
  estadoDesdeShipment,
  fechaDespachoDesdeShipment,
  cambiosParaEnvio,
  sincronizarEnviosDeOrden,
  ordenesDelShipment,
  shipmentIdDeOrden,
  obtenerShipment,
};
