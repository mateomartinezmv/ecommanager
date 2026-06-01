// api/meli/debug-shipment.js
const { getMeliToken } = require('../_meliToken');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { orden_id } = req.query;
  if (!orden_id) return res.status(400).json({ error: 'Falta orden_id' });

  try {
    const token = await getMeliToken();
    const sellerId = 2715667241;

    // 1. Endpoint directo
    const r1 = await fetch(`https://api.mercadolibre.com/orders/${orden_id}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const d1 = await r1.json();
    if (!d1.error) return res.json({ source: 'direct', data: d1 });

    // 2. Merchant orders (Shops usa este)
    const r2 = await fetch(
      `https://api.mercadolibre.com/merchant_orders/search?seller_id=${sellerId}&external_reference=${orden_id}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const d2 = await r2.json();
    if (d2.elements?.length > 0) return res.json({ source: 'merchant_orders_ext', data: d2.elements[0] });

    // 3. Merchant orders por order_id
    const r3 = await fetch(
      `https://api.mercadolibre.com/merchant_orders/${orden_id}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const d3 = await r3.json();
    if (!d3.error) return res.json({ source: 'merchant_order_direct', data: d3 });

    // 4. Orders search por external_reference
    const r4 = await fetch(
      `https://api.mercadolibre.com/orders/search?seller=${sellerId}&external_reference=${orden_id}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const d4 = await r4.json();
    if (d4.results?.length > 0) return res.json({ source: 'search_ext_ref', data: d4.results[0] });

    return res.json({
      error: 'No encontrada en ningún endpoint',
      direct: d1.error,
      merchant_orders: d2.error || `${d2.elements?.length || 0} resultados`,
      merchant_direct: d3.error,
      search_ext: d4.error || `${d4.results?.length || 0} resultados`,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
