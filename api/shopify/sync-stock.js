// api/shopify/sync-stock.js
// POST /api/shopify/sync-stock          → sincroniza todos los productos
// POST /api/shopify/sync-stock { sku }  → sincroniza solo ese producto

const { getShopifyToken } = require('../_shopifyToken');
const { getSupabase } = require('../_supabase');
const { packsDisponibles } = require('../_packs');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SHOP = 'martinez-motos.myshopify.com';

  try {
    const token = await getShopifyToken();
    const supabase = getSupabase();
    const skuFiltro = req.body?.sku || null;

    // Obtener productos con shopify_id (todos o solo el indicado)
    let query = supabase.from('productos').select('sku, nombre, shopify_id, stock_dep, unidades_por_venta').not('shopify_id', 'is', null);
    if (skuFiltro) query = query.eq('sku', skuFiltro);
    const { data: productos, error } = await query;

    if (error) throw error;
    if (!productos.length) return res.json({ ok: true, mensaje: 'No hay productos para sincronizar' });

    // Obtener location_id desde inventory_levels del primer producto
    const firstVariantRes = await fetch(`https://${SHOP}/admin/api/2024-01/variants/${productos[0].shopify_id}.json`, {
      headers: { 'X-Shopify-Access-Token': token },
    });
    const firstVariant = await firstVariantRes.json();
    const firstInventoryItemId = firstVariant.variant?.inventory_item_id;
    if (!firstInventoryItemId) throw new Error('No se pudo obtener inventory_item_id');

    const levelsRes = await fetch(`https://${SHOP}/admin/api/2024-01/inventory_levels.json?inventory_item_ids=${firstInventoryItemId}`, {
      headers: { 'X-Shopify-Access-Token': token },
    });
    const levelsData = await levelsRes.json();
    const locationId = levelsData.inventory_levels?.[0]?.location_id;
    if (!locationId) throw new Error('No se encontró location_id');

    const resultados = [];
    const errores = [];

    for (const p of productos) {
      try {
        const variantRes = await fetch(`https://${SHOP}/admin/api/2024-01/variants/${p.shopify_id}.json`, {
          headers: { 'X-Shopify-Access-Token': token },
        });
        const variantData = await variantRes.json();
        if (!variantData.variant) throw new Error('Variant no encontrado');

        const inventoryItemId = variantData.variant.inventory_item_id;
        // Shopify vende packs; el depósito guarda unidades sueltas.
        const stockPublicado = packsDisponibles(p.stock_dep, p);

        const setRes = await fetch(`https://${SHOP}/admin/api/2024-01/inventory_levels/set.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available: stockPublicado }),
        });
        const setData = await setRes.json();
        if (setData.errors) throw new Error(JSON.stringify(setData.errors));

        await supabase.from('productos').update({ stock_shopify: stockPublicado }).eq('sku', p.sku);
        resultados.push({ sku: p.sku, stock: stockPublicado });
        console.log(`✅ ${p.sku} → ${stockPublicado}`);
      } catch (err) {
        errores.push({ sku: p.sku, error: err.message });
        console.error(`❌ ${p.sku}:`, err.message);
      }
    }

    res.json({ ok: true, sincronizados: resultados.length, errores: errores.length, detalle: resultados, fallos: errores });

  } catch (err) {
    console.error('Error en sync-stock:', err);
    res.status(500).json({ error: err.message });
  }
};
