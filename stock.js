// api/meli/stock.js
// POST /api/meli/stock { meli_id, cantidad } → actualiza stock en MELI y Supabase

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { meli_id, cantidad, sku } = req.body;
  if (!meli_id || cantidad === undefined) {
    return res.status(400).json({ error: 'Faltan parámetros: meli_id y cantidad son requeridos' });
  }

  try {
    const token = await getMeliToken();

    // Actualizar stock en MELI
    const meliRes = await fetch(`https://api.mercadolibre.com/items/${meli_id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ available_quantity: cantidad }),
    });

    const meliData = await meliRes.json();
    if (meliData.error) throw new Error(`MELI error: ${meliData.message}`);

    // Actualizar stock_meli en Supabase si se pasó SKU
    if (sku) {
      const supabase = getSupabase();
      await supabase
        .from('productos')
        .update({ stock_meli: cantidad, updated_at: new Date().toISOString() })
        .eq('sku', sku);
    }

    res.json({ ok: true, meli_id, nueva_cantidad: cantidad });
  } catch (err) {
    console.error('Error actualizando stock MELI:', err);
    res.status(500).json({ error: err.message });
  }
};
