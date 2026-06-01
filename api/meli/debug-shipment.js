// api/meli/debug-shipment.js
// GET /api/meli/debug-shipment?orden_id=XXX

const { getMeliToken } = require('../_meliToken');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { orden_id } = req.query;
  if (!orden_id) return res.status(400).json({ error: 'Falta orden_id' });

  try {
    const token = await getMeliToken();

    // Obtener user ID
    const meRes = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const me = await meRes.json();
    const sellerId = me.id;

    // Intentar endpoint normal
    const orderRes = await fetch(`https://api.mercadolibre.com/orders/${orden_id}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const order = await orderRes.json();

    if (!order.error) {
      return res.json({ source: 'direct', seller_id: sellerId, order_status: order.status, order });
    }

    // Intentar búsqueda por ID (Shops usa este endpoint)
    const searchRes = await fetch(
      `https://api.mercadolibre.com/orders/search?seller=${sellerId}&q=${orden_id}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const search = await searchRes.json();

    if (search.results && search.results.length > 0) {
      return res.json({ source: 'search', seller_id: sellerId, results: search.results });
    }

    // Intentar con pack_id
    const packRes = await fetch(
      `https://api.mercadolibre.com/orders/search?seller=${sellerId}&order.id=${orden_id}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const pack = await packRes.json();

    return res.json({
      seller_id: sellerId,
      direct_error: order.error,
      search_results: search.results?.length || 0,
      pack_results: pack.results?.length || 0,
      pack_raw: pack,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
