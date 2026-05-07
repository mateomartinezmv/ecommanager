// api/meli/recalcular-comisiones.js
// POST /api/meli/recalcular-comisiones
// Re-fetches each unique MELI order and corrects comision (ml fee + seller shipping cost).
// Safe to run multiple times — only updates ventas with canal='meli'.

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

const FLEX_TYPES = ['self_service', 'self_service_flex'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = await getMeliToken();
  const supabase = getSupabase();

  // Get all MELI ventas that have an order ID
  const { data: ventas, error } = await supabase
    .from('ventas')
    .select('id, orden_meli, sku, cantidad, precio_unit, comision')
    .eq('canal', 'meli')
    .not('orden_meli', 'is', null);
  if (error) return res.status(500).json({ error: error.message });

  // Group by orden_meli to avoid duplicate API calls
  const byOrder = {};
  for (const v of ventas) {
    if (!byOrder[v.orden_meli]) byOrder[v.orden_meli] = [];
    byOrder[v.orden_meli].push(v);
  }

  const resultados = [];
  const errores = [];

  for (const [ordenId, items] of Object.entries(byOrder)) {
    try {
      // Fetch order from MELI
      const orderRes = await fetch(`https://api.mercadolibre.com/orders/${ordenId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const order = await orderRes.json();
      if (order.error) { errores.push({ orden: ordenId, error: order.message }); continue; }

      // Fetch shipment para logistic_type (Flex vs ME)
      const shippingId = order.shipping?.id;
      let logisticType = '';
      if (shippingId) {
        try {
          const shipRes = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          const shipData = await shipRes.json();
          logisticType = shipData?.logistic_type || '';
        } catch (_) {}
      }

      const esFlex = FLEX_TYPES.includes(logisticType);
      const grossTotal = (order.order_items || []).reduce((s, i) => s + (i.unit_price * i.quantity), 0) || 1;

      // Método primario: fetchear /payments/{id} directamente para obtener
      // net_received_amount completo (el campo NO viene en /orders/{id})
      const paymentId = (order.payments || []).find(p => p.status === 'approved')?.id;
      let netReceived = 0;
      if (paymentId) {
        try {
          const payRes = await fetch(`https://api.mercadolibre.com/payments/${paymentId}`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          const payData = await payRes.json();
          netReceived = payData.net_received_amount || 0;
          // marketplace_fee como alternativa si net_received no viene
          if (!netReceived && payData.marketplace_fee) {
            // marketplace_fee es el total cobrado por MELI (comisión + envío)
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

        // Find matching venta (by orden_meli + meli_id suffix in id)
        const ventaMatch = items.find(v => v.id === `V_MELI_${ordenId}_${meliItemId}`);
        if (!ventaMatch) continue;

        let nuevaComision;
        if (totalDeductionOrder !== null) {
          // Método primario: proporcional al gross — captura comisión + envío exactos
          nuevaComision = Math.round((totalDeductionOrder * (orderItem.unit_price * orderItem.quantity) / grossTotal) * 100) / 100;
        } else {
          // Fallback: solo sale_fee (al menos la comisión queda correcta)
          nuevaComision = Math.abs(orderItem.sale_fee || 0);
        }

        if (Math.abs(nuevaComision - (ventaMatch.comision || 0)) < 0.01) {
          resultados.push({ id: ventaMatch.id, sin_cambio: true, comision: nuevaComision });
          continue;
        }

        const { error: updErr } = await supabase
          .from('ventas')
          .update({ comision: nuevaComision })
          .eq('id', ventaMatch.id);

        if (updErr) {
          errores.push({ id: ventaMatch.id, error: updErr.message });
        } else {
          resultados.push({
            id: ventaMatch.id,
            anterior: ventaMatch.comision,
            nueva: nuevaComision,
            diff: Math.round((nuevaComision - (ventaMatch.comision || 0)) * 100) / 100,
          });
        }
      }
    } catch (err) {
      errores.push({ orden: ordenId, error: err.message });
    }
  }

  const actualizadas = resultados.filter(r => !r.sin_cambio);
  const sinCambio   = resultados.filter(r => r.sin_cambio);

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
