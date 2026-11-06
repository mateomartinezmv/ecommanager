// api/meli/recalcular-comisiones.js
// POST /api/meli/recalcular-comisiones                          → recalcula TODAS las ventas MELI
// POST /api/meli/recalcular-comisiones?id=XXX                   → recalcula solo la venta con ese id
// POST /api/meli/recalcular-comisiones?desde=AAAA-MM-DD&hasta=… → recalcula las de ese rango de fechas
// GET  /api/meli/recalcular-comisiones?…                        → simulación: mismos filtros, devuelve
//                                                                   los valores nuevos sin escribir nada
// Safe to run multiple times — only updates ventas with canal='meli'.
//
// comision         = cargos por venta + cobro de envío − bonificación de envío (ver _envioMeli.js)
// costo_envio_meli = la parte de envío de esa comisión, con signo (desglose, ya va adentro)

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { envioDeLinea, comisionConEnvio, leerCostosEnvio } = require('./_envioMeli');
const { cargosDeLinea } = require('./_cargosMeli');

// Órdenes en paralelo: de a una, un mes de ventas no entra en los 60s de la función.
const CONCURRENCIA = 6;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

const r2 = v => Math.round(v * 100) / 100;

async function getJson(url, token) {
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  return r.json();
}

async function recalcularOrden(supabase, token, ordenId, items, { simular = false } = {}) {
  const resultados = [];
  const errores = [];

  const order = await getJson(`https://api.mercadolibre.com/orders/${ordenId}`, token);
  if (order.error) { errores.push({ orden: ordenId, error: order.message }); return { resultados, errores }; }

  let shipData = null;
  let costs = null;
  const shippingId = order.shipping?.id;
  if (shippingId) {
    [shipData, costs] = await Promise.all([
      getJson(`https://api.mercadolibre.com/shipments/${shippingId}`, token).catch(() => null),
      leerCostosEnvio(shippingId, token),
    ]);
  }

  const grossTotal = (order.order_items || []).reduce((s, i) => s + (i.unit_price * i.quantity), 0) || 1;

  // Cargos por venta: lo que MELI descuenta del pago (total − neto). Si el pago no se puede
  // leer, el sale_fee de cada ítem, que es POR UNIDAD.
  const paymentId = (order.payments || []).find(p => p.status === 'approved')?.id;
  let netReceived = 0;
  if (paymentId) {
    try {
      const payData = await getJson(`https://api.mercadolibre.com/payments/${paymentId}`, token);
      netReceived = payData.net_received_amount || 0;
      if (!netReceived && payData.marketplace_fee) {
        netReceived = grossTotal - Math.abs(payData.marketplace_fee);
      }
    } catch (_) {}
  }

  for (const orderItem of (order.order_items || [])) {
    const meliItemId = orderItem.item?.id;
    if (!meliItemId) continue;

    const ventaMatch = items.find(v => v.id === `V_MELI_${ordenId}_${meliItemId}`);
    if (!ventaMatch) continue;

    const lineaTotal = orderItem.unit_price * orderItem.quantity;
    // Del pago, del sale_fee o de la tabla de tarifas si MELI no mandó ninguno (_cargosMeli.js).
    const { cargos, saleFee, fuente } = await cargosDeLinea({ order, item: orderItem, token, netReceived });
    if (cargos <= 0) {
      errores.push({ id: ventaMatch.id, error: 'MELI no devolvió los cargos por venta (sale_fee, pago ni tarifas)' });
      continue;
    }

    const nuevoCostoEnvio = envioDeLinea(shipData, costs, lineaTotal, grossTotal);
    const nuevaComision = comisionConEnvio({ cargos, saleFee, envio: nuevoCostoEnvio });

    const comisionSinCambio = Math.abs(nuevaComision - (parseFloat(ventaMatch.comision) || 0)) < 0.01;
    const envioSinCambio = Math.abs(nuevoCostoEnvio - (parseFloat(ventaMatch.costo_envio_meli) || 0)) < 0.01;

    if (comisionSinCambio && envioSinCambio) {
      resultados.push({ id: ventaMatch.id, sin_cambio: true, comision: nuevaComision });
      continue;
    }

    const { error: updErr } = simular ? { error: null } : await supabase
      .from('ventas')
      .update({ comision: nuevaComision, costo_envio_meli: nuevoCostoEnvio })
      .eq('id', ventaMatch.id);

    if (updErr) {
      errores.push({ id: ventaMatch.id, error: updErr.message });
    } else {
      resultados.push({
        id: ventaMatch.id,
        anterior: parseFloat(ventaMatch.comision) || 0,
        nueva: nuevaComision,
        diff: r2(nuevaComision - (parseFloat(ventaMatch.comision) || 0)),
        costoEnvio: nuevoCostoEnvio,
        fuenteCargos: fuente,
        logistic_type: shipData?.logistic_type || null,
      });
    }
  }
  return { resultados, errores };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // GET nunca escribe: sirve para ver qué cambiaría antes de tocar las ventas.
  const simular = req.method === 'GET';

  const ventaId = req.query.id || null;
  const desde = req.query.desde || null;
  const hasta = req.query.hasta || null;
  if ((desde && !FECHA_RE.test(desde)) || (hasta && !FECHA_RE.test(hasta)))
    return res.status(400).json({ error: 'desde/hasta tienen que ser AAAA-MM-DD' });

  const token = await getMeliToken();
  const supabase = getSupabase();

  let query = supabase
    .from('ventas')
    .select('id, orden_meli, sku, cantidad, precio_unit, comision, costo_envio_meli')
    .eq('canal', 'meli')
    .not('orden_meli', 'is', null)
    .limit(50000);
  if (ventaId) query = query.eq('id', ventaId);
  if (desde) query = query.gte('fecha', desde);
  if (hasta) query = query.lte('fecha', hasta);

  const { data: ventas, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  if (ventaId && (!ventas || ventas.length === 0))
    return res.status(404).json({ error: 'Venta no encontrada' });

  const byOrder = {};
  for (const v of ventas) {
    if (!byOrder[v.orden_meli]) byOrder[v.orden_meli] = [];
    byOrder[v.orden_meli].push(v);
  }

  const resultados = [];
  const errores = [];
  const cola = Object.entries(byOrder);

  async function worker() {
    while (cola.length) {
      const [ordenId, items] = cola.shift();
      try {
        const r = await recalcularOrden(supabase, token, ordenId, items, { simular });
        resultados.push(...r.resultados);
        errores.push(...r.errores);
      } catch (err) {
        errores.push({ orden: ordenId, error: err.message });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCIA }, worker));

  const actualizadas = resultados.filter(r => !r.sin_cambio);
  const sinCambio = resultados.filter(r => r.sin_cambio);

  console.log(`✅ Recalculo comisiones${simular ? ' (simulación)' : ''}: ${actualizadas.length} actualizadas, ${sinCambio.length} sin cambio, ${errores.length} errores`);

  res.json({
    ok: true,
    simulacion: simular,
    actualizadas: actualizadas.length,
    sin_cambio: sinCambio.length,
    errores: errores.length,
    detalle: actualizadas,
    fallos: errores,
  });
};

module.exports.recalcularOrden = recalcularOrden;

/**
 * Ventas MELI que quedaron sin cargos por venta: la comisión es sólo el envío (o 0). MELI
 * nunca cobra $0 por vender, así que es que el aviso de la orden llegó sin sale_fee.
 */
function sinCargos(v) {
  return Math.abs((parseFloat(v.comision) || 0) - (parseFloat(v.costo_envio_meli) || 0)) < 0.01;
}

/**
 * Red de contención para el cron: vuelve a calcular la comisión de las ventas MELI recientes
 * que quedaron sin cargos por venta. Las que MELI siga sin informar se reintentan en la
 * próxima pasada.
 */
async function recalcularSinCargos({ dias = 60, limit = 20 } = {}) {
  const supabase = getSupabase();
  const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('ventas')
    .select('id, orden_meli, sku, cantidad, precio_unit, total, comision, costo_envio_meli, estado')
    .eq('canal', 'meli')
    .not('orden_meli', 'is', null)
    .gte('fecha', desde)
    .gt('total', 0)
    .neq('estado', 'cancelada')
    .order('fecha', { ascending: false })
    .limit(5000);
  if (error) throw new Error(error.message);

  const byOrder = {};
  for (const v of (data || []).filter(sinCargos)) (byOrder[v.orden_meli] ||= []).push(v);
  const ordenes = Object.entries(byOrder).slice(0, limit);
  if (!ordenes.length) return { revisadas: 0, actualizadas: 0, errores: 0, detalle: [], fallos: [] };

  const token = await getMeliToken();
  const detalle = [];
  const fallos = [];
  for (const [ordenId, items] of ordenes) {
    try {
      const r = await recalcularOrden(supabase, token, ordenId, items);
      detalle.push(...r.resultados.filter(x => !x.sin_cambio));
      fallos.push(...r.errores);
    } catch (err) {
      fallos.push({ orden: ordenId, error: err.message });
    }
  }
  return { revisadas: ordenes.length, actualizadas: detalle.length, errores: fallos.length, detalle, fallos };
}

module.exports.sinCargos = sinCargos;
module.exports.recalcularSinCargos = recalcularSinCargos;
