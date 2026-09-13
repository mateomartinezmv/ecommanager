// api/meli/sync-stock.js
// POST /api/meli/sync-stock          → sincroniza todos los productos CRM → MELI
// POST /api/meli/sync-stock { sku }  → sincroniza solo ese SKU

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { meliIdsDe } = require('../_meliIds');
const { syncMeliStock } = require('../_stockSync');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const token = await getMeliToken();
    const supabase = getSupabase();
    const skuFiltro = req.body?.sku || null;

    // Obtener productos con alguna publicación (todos o solo el indicado)
    let query = supabase.from('productos').select('sku, nombre, meli_id, meli_ids, stock_dep').not('meli_id', 'is', null);
    if (skuFiltro) query = query.eq('sku', skuFiltro);
    const { data: productos, error } = await query;
    if (error) throw error;
    if (!productos.length) return res.json({ ok: true, mensaje: 'No hay productos para sincronizar' });

    const resultados = [];
    const errores = [];

    for (const p of productos) {
      // Cada publicación del SKU lleva su propio available_quantity y todas
      // venden del mismo depósito: se empuja el mismo stock_dep a todas.
      let algunaOk = false;

      for (const meliId of meliIdsDe(p)) {
        try {
          await syncMeliStock(token, meliId, p.stock_dep);
          algunaOk = true;
          resultados.push({ sku: p.sku, meli_id: meliId, stock: p.stock_dep });
          console.log(`✅ ${p.sku} (${meliId}) → ${p.stock_dep}`);
        } catch (err) {
          errores.push({ sku: p.sku, meli_id: meliId, error: err.message });
          console.error(`❌ ${p.sku} (${meliId}):`, err.message);
        }
      }

      // Los espejos del CRM se actualizan si al menos una publicación aceptó.
      if (algunaOk) {
        await supabase.from('productos').update({
          stock_meli: p.stock_dep,
          stock_shopify: p.stock_dep,
        }).eq('sku', p.sku);
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
