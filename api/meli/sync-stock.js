// api/meli/sync-stock.js
// POST /api/meli/sync-stock          → sincroniza todos los productos CRM → MELI
// POST /api/meli/sync-stock { sku }  → sincroniza solo ese SKU

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const token = await getMeliToken();
    const supabase = getSupabase();
    const skuFiltro = req.body?.sku || null;

    // Obtener productos con meli_id (todos o solo el indicado)
    let query = supabase.from('productos').select('sku, nombre, meli_id, stock_dep').not('meli_id', 'is', null);
    if (skuFiltro) query = query.eq('sku', skuFiltro);
    const { data: productos, error } = await query;
    if (error) throw error;
    if (!productos.length) return res.json({ ok: true, mensaje: 'No hay productos para sincronizar' });

    const resultados = [];
    const errores = [];

    for (const p of productos) {
      try {
        const meliRes = await fetch(`https://api.mercadolibre.com/items/${p.meli_id}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ available_quantity: p.stock_dep }),
        });
        const meliData = await meliRes.json();
        if (meliData.error) throw new Error(meliData.message);

        // Actualizar campos espejo en CRM
        await supabase.from('productos').update({
          stock_meli: p.stock_dep,
          stock_shopify: p.stock_dep,
        }).eq('sku', p.sku);

        resultados.push({ sku: p.sku, meli_id: p.meli_id, stock: p.stock_dep });
        console.log(`✅ ${p.sku} (${p.meli_id}) → ${p.stock_dep}`);
      } catch (err) {
        errores.push({ sku: p.sku, meli_id: p.meli_id, error: err.message });
        console.error(`❌ ${p.sku}:`, err.message);
      }
    }

    res.json({
      ok: true,
      sincronizados: resultados.length,
      errores: errores.length,
      detalle: resultados,
      fallos: errores,
    });
  } catch (err) {
    console.error('Error en meli/sync-stock:', err);
    res.status(500).json({ error: err.message });
  }
};
