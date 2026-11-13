// api/meli/notify.js
// POST /api/meli/notify → recibe notificaciones de MELI (ventas, calificaciones, items)

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { buscarProductoPorMeliId } = require('../_meliIds');
const { descontarStock, ventaNueva, resumenSync } = require('../_stockSync');
const { unidadesDeDeposito } = require('../_packs');
const { detectarZona, detectarZonaDesdeShipData, COSTOS_ENVIOSUY } = require('../_flexZonas');
const {
  obtenerShipment, ordenesDelShipment, sincronizarEnviosDeOrden,
  estadoDesdeShipment, fechaDespachoDesdeShipment,
} = require('../_meliEnvios');
const { packIdDeOrden, ordenesDelPaquete, registrarEnvioDePaquete } = require('../_meliPaquetes');
const { envioDeLinea, comisionConEnvio, leerCostosEnvio } = require('./_envioMeli');
const { cargosDeLinea } = require('./_cargosMeli');
const { esc, enviar: sendTelegram } = require('../_telegram');
const { avisarPregunta } = require('../_telegramPreguntas');

const FLEX_TYPES = ['self_service', 'self_service_flex'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const { topic, resource } = req.body || {};
  console.log('MELI notify:', topic, resource);

  try {
    // El tópico `items` ya no se procesa: sólo servía para el aviso de "Publicación pausada",
    // que MELI dispara con cualquier cambio de una publicación pausada (precio, promo, una
    // revisión suya) y llegaba repetido días después de pausarla. Las pausas se ven en el CRM.
    if (topic === 'orders_v2' || topic === 'orders') {
      await handleOrder(resource);
    } else if (topic === 'shipments') {
      await handleShipment(resource);
    } else if (topic === 'questions') {
      await handleQuestion(resource);
    }
  } catch (err) {
    console.error('Error procesando notificación MELI:', err.message);
  }

  return res.status(200).json({ ok: true });
};

// ── ÓRDENES ──────────────────────────────────────────────────
async function handleOrder(resource) {
  const token = await getMeliToken();
  const supabase = getSupabase();

  const orderId = resource.replace('/orders/', '').split('/')[0];

  let order;
  try {
    const orderRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    order = await orderRes.json();
  } catch (fetchErr) {
    console.error(`❌ fetch orden ${orderId} fallido:`, fetchErr.message, fetchErr.cause?.message || '');
    return;
  }

  // Fallback para órdenes de Mercado Shops (no accesibles por endpoint directo)
  if (order.error) {
    console.log(`⚠️ Orden ${orderId} no encontrada directo, intentando search (Shops)...`);
    try {
      const meRes = await fetch('https://api.mercadolibre.com/users/me', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const me = await meRes.json();
      const searchRes = await fetch(
        `https://api.mercadolibre.com/orders/search?seller=${me.id}&q=${orderId}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const search = await searchRes.json();
      if (search.results && search.results.length > 0) {
        order = search.results.find(o => String(o.id) === String(orderId));
      }
    } catch (fetchErr) {
      console.error(`❌ fetch fallback orden ${orderId} fallido:`, fetchErr.message, fetchErr.cause?.message || '');
      return;
    }
    if (!order || order.error) {
      console.log(`❌ Orden ${orderId} no encontrada en ningún endpoint`);
      return;
    }
    console.log(`✅ Orden ${orderId} encontrada via search (Shops)`);
  }

  if (order.status !== 'paid') return;

  // ── Datos de envío: logistic_type real → detección de Flex + zona ────────
  const shippingId = order.shipping?.id;
  let logisticType = '';
  let direccion = null;
  let zonaFlex = null;
  let shipData = null;
  if (shippingId) {
    try {
      const shipRes = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      shipData = await shipRes.json();
      logisticType = shipData?.logistic_type || '';
      if (shipData?.receiver_address) {
        const addr = shipData.receiver_address;
        direccion = [addr.street_name, addr.street_number, addr.neighborhood?.name, addr.city?.name, addr.state?.name]
          .filter(Boolean).join(', ');
      }
      if (FLEX_TYPES.includes(logisticType)) {
        zonaFlex = detectarZonaDesdeShipData(shipData) || (direccion ? detectarZona(direccion) : null);
      }
    } catch (e) {
      console.error(`❌ fetch shipment ${shippingId} fallido:`, e.message);
    }
  }
  // Qué cobra o bonifica MELI por el envío al vendedor (ver _envioMeli.js).
  const costosEnvio = await leerCostosEnvio(shippingId, token);
  const esFlex = FLEX_TYPES.includes(logisticType);
  const transportista = esFlex ? 'enviosuy' : 'mercado_envios';
  const costoEnvio = esFlex ? (zonaFlex ? (COSTOS_ENVIOSUY[zonaFlex] ?? 0) : 0) : 0;

  // Un carrito de MELI llega como varias órdenes atadas por el mismo pack: es
  // UNA compra, con UN envío. El pack es lo que las une.
  const packId = packIdDeOrden(order);

  const grossTotal = (order.order_items || []).reduce((s, i) => s + (i.unit_price * i.quantity), 0) || 1;

  for (const item of order.order_items) {
    const meliItemId = item.item.id;
    const cantidad = item.quantity;
    const precioUnit = item.unit_price;

    // Busca entre TODAS las publicaciones del SKU, no sólo la principal.
    const producto = await buscarProductoPorMeliId(supabase, meliItemId);

    if (!producto) {
      // Antes esto era un `continue` mudo: la venta se perdía y el stock
      // quedaba inflado sin que nadie se enterara. Ahora avisa.
      console.log(`Producto con MELI ID ${meliItemId} no encontrado en DB`);
      await sendTelegram(
        `⚠️ <b>Venta sin registrar</b>\n\n` +
        `La publicación <b>${esc(meliItemId)}</b> no está vinculada a ningún SKU del CRM, ` +
        `así que la orden <b>${esc(String(order.id))}</b> no se registró y el stock no se descontó.\n\n` +
        `📦 <b>Publicación:</b> ${esc(item.item.title || '—')}\n` +
        `🔢 <b>Cantidad:</b> ${cantidad}\n\n` +
        `Vinculá esa publicación al SKU en el CRM y reprocesá la orden.`
      );
      continue;
    }

    const ventaId = 'V_MELI_' + order.id + '_' + item.item.id;
    // Cargos por venta: del pago, del sale_fee o, si MELI todavía no los mandó, de la tabla
    // de tarifas (ver _cargosMeli.js). El envío que cobra MELI (Mercado Envíos con envío
    // gratis) o la bonificación de Flex se ajustan aparte (ver _envioMeli.js).
    const { cargos: cargosItem, saleFee: saleFeeItem, fuente: fuenteCargos } = await cargosDeLinea({ order, item, token });
    if (fuenteCargos !== 'pago' && fuenteCargos !== 'sale_fee') {
      console.log(`⚠️ Orden ${order.id} ${item.item.id}: cargos por venta desde ${fuenteCargos} ($${cargosItem})`);
    }
    const envioMeliItem = envioDeLinea(shipData, costosEnvio, precioUnit * cantidad, grossTotal);
    const comisionItem = comisionConEnvio({ cargos: cargosItem, saleFee: saleFeeItem, envio: envioMeliItem });

    // Primero la venta, después el stock. MELI manda varios avisos de la misma
    // orden en el mismo segundo; antes se descontaba y recién después se
    // insertaba, así que cada aviso que entraba en el medio volvía a descontar
    // (una venta de 1 bajó 3 unidades). Ahora sólo descuenta el aviso que
    // logró insertar la venta.
    const alta = await ventaNueva(supabase, {
      id: ventaId,
      canal: 'meli',
      fecha: order.date_created?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      orden_meli: String(order.id),
      // El panel de MELI muestra el pack_id, no el order_id: sin esto, buscar la
      // venta por el número que figura en pantalla no la encuentra. Además es lo
      // que ata las órdenes de un mismo carrito: una compra, un envío.
      pack_id: packId,
      // Un SKU puede tener varias publicaciones: sin esto no queda registro de
      // cuál vendió, porque la venta guarda el nombre interno del producto.
      meli_item_id: meliItemId,
      comprador: order.buyer?.nickname || '',
      sku: producto.sku,
      producto: producto.nombre,
      cantidad,
      precio_unit: precioUnit,
      comision: comisionItem,
      costo_envio_meli: envioMeliItem,
      total: precioUnit * cantidad,
      estado: 'pagada',
      genera_envio: !!shippingId,
    });

    if (alta.error) {
      console.error(`❌ No se pudo registrar la venta de la orden ${order.id}: ${alta.error.message} — stock sin tocar`);
      continue;
    }
    if (!alta.nueva) {
      console.log(`ℹ️ Venta ya existente: orden ${order.id} — omitiendo`);
      continue;
    }
    console.log(`✅ Venta MELI registrada: orden ${order.id}`);

    // MELI vende packs (1 par de sliders = cantidad 1); el depósito pierde
    // unidades_por_venta unidades por cada uno. MELI sólo descuenta la
    // publicación que vendió: las hermanas y Shopify se bajan acá.
    const sync = await descontarStock(supabase, producto, unidadesDeDeposito(cantidad, producto));
    console.log('📉 Venta MELI:', resumenSync(producto.sku, sync));
  }

  // ── Un solo envío por paquete ───────────────────────────────────────────
  // Fuera del loop a propósito: el envío es del paquete, no del ítem. Corre
  // siempre (es idempotente), incluso si las ventas ya existían, para no
  // depender de que todo ocurra en la misma invocación del webhook.
  if (shippingId) {
    const ordenes = await ordenesDelPaquete(token, order, shippingId);
    const r = await registrarEnvioDePaquete(supabase, {
      order,
      packId,
      ordenes,
      datos: {
        comprador: order.buyer?.nickname || '',
        transportista,
        tracking: shipData?.tracking_number || null,
        fechaDespacho: fechaDespachoDesdeShipment(shipData),
        // Si la orden se procesa tarde (reintento del webhook, reproceso
        // manual) el paquete ya puede estar viajando: se guarda el estado real.
        estado: estadoDesdeShipment(shipData) || 'pendiente',
        direccion: direccion || null,
        costo: costoEnvio,
        zona: zonaFlex,
      },
    });
    if (r.creado) {
      console.log(`✅ Envío creado: ${r.id} (orden ${order.id}${packId ? `, pack ${packId}` : ''}) — ${transportista} $${costoEnvio}`);
    } else if (r.id) {
      console.log(`ℹ Envío ${r.id} ya existía para el paquete — no se duplica (orden ${order.id})`);
    }
  }
}

// ── ENVÍOS (shipments) ───────────────────────────────────────
// Cada notificación del tópico `shipments` refleja el estado real del paquete
// sobre el CRM: pendiente → en camino → entregado (y problema si MELI lo marca
// como no entregado o cancelado). No avisa por Telegram: es información que se
// consulta cuando hace falta, no algo que amerite interrumpir.
async function handleShipment(resource) {
  const token = await getMeliToken();
  const supabase = getSupabase();

  const shipmentId = resource.split('/').pop();
  let shipment;
  try {
    shipment = await obtenerShipment(token, shipmentId);
  } catch (e) { console.error('fetch shipment fallido:', e.message); return; }
  if (!shipment) {
    console.log(`Shipment ${shipmentId} no disponible`);
    return;
  }

  // Un shipment puede cubrir varias órdenes (carrito) y cada orden varios ítems,
  // así que se resuelven todas y se actualizan todos sus envíos.
  const ordenes = await ordenesDelShipment(token, shipmentId, shipment);
  if (ordenes.length === 0) {
    console.log(`⚠ Shipment ${shipmentId}: no se pudo resolver la orden`);
    return;
  }

  for (const orden of ordenes) {
    try {
      const aplicados = await sincronizarEnviosDeOrden(supabase, orden, shipment);
      for (const c of aplicados) {
        console.log(
          `✅ Envío ${c.id}: ${c.estadoAnterior} → ${c.estado || c.estadoAnterior}` +
          ` | status MELI ${shipment.status}/${shipment.substatus || '—'}`
        );
      }
      if (aplicados.length === 0) {
        console.log(`ℹ Orden ${orden}: sin cambios (status ${shipment.status})`);
      }
    } catch (err) {
      console.error(`❌ Error sincronizando orden ${orden}:`, err.message);
    }
  }
}

// ── PREGUNTAS ────────────────────────────────────────────────
// Llega a Telegram con la respuesta ya redactada y los botones Aceptar / Rechazar (ver
// _telegramPreguntas.js, que además evita los avisos repetidos).
async function handleQuestion(resource) {
  const questionId = String(resource || '').split('/').pop();
  if (!/^\d+$/.test(questionId)) {
    console.log('Pregunta con resource inesperado:', resource);
    return;
  }
  const r = await avisarPregunta(getSupabase(), questionId);
  console.log(`Pregunta ${questionId}: ${r.estado}`);
}
