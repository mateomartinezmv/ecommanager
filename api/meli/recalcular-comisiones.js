// api/meli/recalcular-comisiones.js
// POST /api/meli/recalcular-comisiones           → recalcula TODAS las ventas MELI
// POST /api/meli/recalcular-comisiones?id=XXX    → recalcula solo la venta con ese id
// Safe to run multiple times — only updates ventas with canal='meli'.

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

const FLEX_TYPES = ['self_service', 'self_service_flex'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = await getMeliToken();
  const supabase = getSupabase();
  const ventaId = req.query.id || null;

  let query = supabase
    .from('ventas')
    .select('id, orden_meli, sku, cantidad, precio_unit, comision, costo_envio_meli')
    .eq('canal', 'meli')
    .not('orden_meli', 'is', null);
  if (ventaId) query = query.eq('id', ventaId);

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

  for (const [ordenId, items] of Object.entries(byOrder)) {
    try {
      const orderRes = await fetch(`https://api.mercadolibre.com/orders/${ordenId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const order = await orderRes.json();
      if (order.error) { errores.push({ orden: ordenId, error: order.message }); continue; }

      const shippingId = order.shipping?.id;
      let logisticType = '';
      let costoEnvioReal = 0;

      if (shippingId) {
        try {
          const shipRes = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          const shipData = await shipRes.json();
          logisticType = shipData?.logistic_type || '';
          const opt = shipData?.shipping_option || {};

          console.log(`  🚚 shipment ${shippingId} [${ordenId}]: logistic_type=${logisticType} | opt.cost=${opt.cost} opt.list_cost=${opt.list_cost} base_cost=${shipData?.base_cost}`);

          // ── Lógica de costo de envío ─────────────────────────────────────
          // net_amount: lo que MELI descuenta al vendedor por el envío.
          // Si net_amount existe y es 0 → el comprador pagó el envío → costo vendedor = $0
          // Si net_amount > 0 → lo paga el vendedor → usar ese valor
          // Fallback: list_cost (precio de lista del envío) solo si net_amount no está disponible
          const netAmount = opt.net_amount ?? opt.cost;
          if (netAmount !== null && netAmount !== undefined) {
            // net_amount = 0 → comprador paga → tu costo = 0
            costoEnvioReal = netAmount === 0 ? 0 : netAmount;
          } else if (opt.list_cost !== null && opt.list_cost !== undefined) {
            // list_cost = 0 → envío gratis para el vendedor también
            costoEnvioReal = opt.list_cost === 0 ? 0 : opt.list_cost;
          } else {
            costoEnvioReal = shipData?.base_cost ?? 0;
          }
          // ────────────────────────────────────────────────────────────────
        } catch (_) {}
      }

      const esFlex = FLEX_TYPES.includes(logisticType);
      const grossTotal = (order.order_items || []).reduce((s, i) => s + (i.unit_price * i.quantity), 0) || 1;

      const paymentId = (order.payments || []).find(p => p.status === 'approved')?.id;
      let netReceived = 0;
      if (paymentId) {
        try {
          const payRes = await fetch(`https://api.mercadolibre.com/payments/${paymentId}`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          const payData = await payRes.json();
          netReceived = payData.net_received_amount || 0;
          if (!netReceived && payData.marketplace_fee) {
            netReceived = grossTotal - Math.abs(payData.marketplace_fee);
          }
          console.log(`  💳 payment ${paymentId}: net_received=${payData.net_received_amount} marketplace_fee=${payData.marketplace_fee}`);
        } catch (_) {}
      }

      const totalDeductionOrder = (netReceived > 0 && netReceived < grossTotal)
        ? Math.round((grossTotal - netReceived) * 100) / 100
        : null;

      for (const orderItem of (order.order_items || [])) {
        const meliItemId = orderItem.item?.id;
        if (!meliItemId) continue;

        const ventaMatch = items.find(v => v.id === `V_MELI_${ordenId}_${meliItemId}`);
        if (!ventaMatch) continue;

        let nuevaComision;
        if (totalDeductionOrder !== null) {
          nuevaComision = Math.round((totalDeductionOrder * (orderItem.unit_price * orderItem.quantity) / grossTotal) * 100) / 100;
        } else {
          nuevaComision = Math.abs(orderItem.sale_fee || 0);
        }

        // Si el costo de envío ya está incluido en la deducción total (net_received),
        // no sumarlo de nuevo al costo de envío separado
        const nuevoCostoEnvio = !esFlex
          ? Math.round((costoEnvioReal * (orderItem.unit_price * orderItem.quantity) / grossTotal) * 100) / 100
          : 0;

        const comisionSinCambio = Math.abs(nuevaComision - (ventaMatch.comision || 0)) < 0.01;
        const envioSinCambio    = Math.abs(nuevoCostoEnvio - (ventaMatch.costo_envio_meli || 0)) < 0.01;

        if (comisionSinCambio && envioSinCambio) {
          resultados.push({ id: ventaMatch.id, sin_cambio: true, comision: nuevaComision });
          continue;
        }

        const { error: updErr } = await supabase
          .from('ventas')
          .update({ comision: nuevaComision, costo_envio_meli: nuevoCostoEnvio })
          .eq('id', ventaMatch.id);

        if (updErr) {
          errores.push({ id: ventaMatch.id, error: updErr.message });
        } else {
          resultados.push({
            id: ventaMatch.id,
            anterior: ventaMatch.comision,
            nueva: nuevaComision,
            diff: Math.round((nuevaComision - (ventaMatch.comision || 0)) * 100) / 100,
            costoEnvio: nuevoCostoEnvio,
          });
        }
      }
    } catch (err) {
      errores.push({ orden: ordenId, error: err.message });
    }
  }

  const actualizadas = resultados.filter(r => !r.sin_cambio);
  const sinCambio    = resultados.filter(r => r.sin_cambio);

  console.log(`✅ Recalculo comisiones: ${actualizadas.length} actualizadas, ${sinCambio.length} sin cambio, ${errores.length} errores`);

  res.json({
    ok: true,
    actualizadas: actualizadas.length,
    sin_cambio: sinCambio.length,
    errores: errores.length,
    detalle: actualizadas,
    fallos: errores,
  });
};
