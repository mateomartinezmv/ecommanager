// api/meli/debug.js
// GET /api/meli/debug?item_id=MLUU3734564029

const { getMeliToken } = require('../_meliToken');

module.exports = async (req, res) => {
  const { item_id } = req.query;
  if (!item_id) return res.status(400).json({ error: 'Falta item_id' });

  try {
    const token = await getMeliToken();

    // 1. Ver info del token / usuario
    const meRes = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const me = await meRes.json();

    // 2. Ver info del item
    const itemRes = await fetch(`https://api.mercadolibre.com/items/${item_id}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const item = await itemRes.json();

    res.json({
      usuario: { id: me.id, nickname: me.nickname, site_id: me.site_id },
      item: {
        id: item.id,
        title: item.title,
        status: item.status,
        seller_id: item.seller_id,
        available_quantity: item.available_quantity,
        error: item.error || null,
        message: item.message || null,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
