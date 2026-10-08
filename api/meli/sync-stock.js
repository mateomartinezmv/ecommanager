// api/meli/sync-stock.js
// POST /api/meli/sync-stock          → repasa todos los productos con publicaciones
// POST /api/meli/sync-stock { sku }  → sólo ese SKU
//
// Red de seguridad para MELI, equivalente a shopify/sync-stock. Empuja a todas
// las publicaciones del SKU (cada una lleva su propio available_quantity y
// todas venden del mismo depósito) y, por el mismo camino, deja Shopify en el
// mismo número: las tres columnas del CRM son el espejo de stock_dep, no
// números con vida propia.

const { getSupabase } = require('../_supabase');
const { sincronizarStock, resumenSync } = require('../_stockSync');
const { FILTRO_SYNC_STOCK } = require('../_discontinuado');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const supabase = getSupabase();
    const skuFiltro = req.body?.sku || null;

    let query = supabase
      .from('productos')
      .select('sku, nombre, meli_id, meli_ids, shopify_id, stock_dep, unidades_por_venta')
      .not('meli_id', 'is', null)
      // Los descatalogados que todavía tienen unidades entran igual: siguen vendiendo hasta
      // agotarse y su publicación tiene que mostrar el stock real. Los que ya están en cero
      // quedan afuera (ver entraEnSyncStock en _discontinuado.js).
      .or(FILTRO_SYNC_STOCK);
    if (skuFiltro) query = query.eq('sku', skuFiltro);

    const { data: productos, error } = await query.order('sku');
    if (error) throw error;
    if (!productos.length) return res.json({ ok: true, mensaje: 'No hay productos para sincronizar' });

    const resultados = [];
    const errores = [];

    for (const p of productos) {
      const sync = await sincronizarStock(supabase, p, p.stock_dep);
      console.log('🔁', resumenSync(p.sku, sync));

      if (sync.error) { errores.push({ sku: p.sku, error: sync.error }); continue; }

      for (const meliId of sync.meli.sincronizadas) {
        resultados.push({ sku: p.sku, meli_id: meliId, stock: sync.stockPublicado });
      }
      for (const e of sync.meli.errores) {
        errores.push({ sku: p.sku, meli_id: e.meliId, error: e.error });
      }
      if (sync.shopify.error && !/no existe en Shopify/.test(sync.shopify.error)) {
        errores.push({ sku: p.sku, error: `Shopify: ${sync.shopify.error}` });
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
