// api/meli/debug-shipment.js
const { getMeliToken } = require('../_meliToken');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { orden_id } = req.query;
  if (!orden_id) return res.status(400).json({ error: 'Falta orden_id' });

  try {
    const token = await getMeliToken();
    const sellerId = 2715667241;

    // 0. Shipment crudo (para inspeccionar campos de transportista/carrier)
    if (req.query.shipment === '1') {
      const orderRes = await fetch(`https://api.mercadolibre.com/orders/${orden_id}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const order = await orderRes.json();
      const shippingId = order?.shipping?.id;
      if (!shippingId) return res.json({ error: 'Orden sin shipping_id', order });
      const shipRes = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const shipment = await shipRes.json();

      // Probar varios endpoints/campos que podrían tener el nombre del repartidor individual
      const probe = async (url) => {
        try {
          const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
          const j = await r.json();
          return { status: r.status, data: j };
        } catch (e) { return { error: e.message }; }
      };

      const [carrier, history, trackingPublic, lead_time] = await Promise.all([
        probe(`https://api.mercadolibre.com/shipments/${shippingId}/carrier`),
        probe(`https://api.mercadolibre.com/shipments/${shippingId}/history`),
        probe(`https://api.mercadolibre.com/shipments/${shippingId}/tracking`),
        probe(`https://api.mercadolibre.com/shipments/${shippingId}/lead_time`),
      ]);

      return res.json({ shippingId, order_status: order.status, shipment, carrier, history, trackingPublic, lead_time });
    }

    // 1. Endpoint directo
    const r1 = await fetch(`https://api.mercadolibre.com/orders/${orden_id}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const d1 = await r1.json();
    if (!d1.error) return res.json({ source: 'direct', data: d1 });

    // 2. search por seller + order id exacto
    const r2 = await fetch(
      `https://api.mercadolibre.com/orders/search?seller=${sellerId}&order.id=${orden_id}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const d2 = await r2.json();
    if (d2.results?.length > 0) return res.json({ source: 'search_order_id', data: d2.results[0] });

    // 3. Merchant orders directo
    const r3 = await fetch(
      `https://api.mercadolibre.com/merchant_orders/${orden_id}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const d3 = await r3.json();
    if (!d3.error) return res.json({ source: 'merchant_order_direct', data: d3 });

    // 4. Merchant orders search
    const r4 = await fetch(
      `https://api.mercadolibre.com/merchant_orders/search?seller_id=${sellerId}&order_id=${orden_id}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const d4 = await r4.json();
    if (d4.elements?.length > 0) return res.json({ source: 'merchant_search_order_id', data: d4.elements[0] });

    // 5. Shops orders endpoint
    const r5 = await fetch(
      `https://api.mercadolibre.com/mshops/mp-seller/orders?seller_id=${sellerId}&order_id=${orden_id}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const d5 = await r5.json();
    if (!d5.error) return res.json({ source: 'mshops', data: d5 });

    return res.json({
      none_found: true,
      direct: d1.error,
      search_order_id: d2.error || `${d2.results?.length || 0} resultados`,
      merchant_direct: d3.error,
      merchant_search: d4.error || `${d4.elements?.length || 0} resultados`,
      mshops: d5.error || d5.message,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
