// api/shopify/sync-stock.js
// POST /api/shopify/sync-stock → empuja stock del CRM a Shopify para todos los productos con shopify_id

const { getShopifyToken } = require('../_shopifyToken');
const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SHOP = 'martinez-motos.myshopify.com';

  try {
    const token = await getShopifyToken();
    const supabase = getSupabase();

    // Obtener todos los productos con shopify_id
    const { data: productos, error } = await supabase
      .from('productos')
      .select('sku, nombre, shopify_id, stock_dep')
      .not('shopify_id', 'is', null);

    if (error) throw error;
    if (!productos.length) return res.json({ ok: true, mensaje: 'No hay productos con Shopify ID configurado' });

    // Obtener location_id de Shopify (primera ubicación)
    const locRes = await fetch(`https://${SHOP}/admin/api/2024-01/locations.json`, {
      headers: { 'X-Shopify-Access-Token': token },
    });
    const locData = await locRes.json();
    const locationId = locData.locations?.[0]?.id;
    if (!locationId) throw new Error('No se encontró ubicación en Shopify');

    const resultados = [];
    const errores = [];

    for (const p of productos) {
      try {
        // Obtener inventory_item_id desde el variant
        const variantRes = await fetch(`https://${SHOP}/admin/api/2024-01/variants/${p.shopify_id}.json`, {
          headers: { 'X-Shopify-Access-Token': token },
        });
        const variantData = await variantRes.json();
        if (!variantData.variant) throw new Error('Variant no encontrado');

        const inventoryItemId = variantData.variant.inventory_item_id;

        // Actualizar stock en Shopify
        const setRes = await fetch(`https://${SHOP}/admin/api/2024-01/inventory_levels/set.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location_id: locationId,
            inventory_item_id: inventoryItemId,
            available: p.stock_dep,
          }),
        });
        const setData = await setRes.json();
        if (setData.errors) throw new Error(JSON.stringify(setData.errors));

        // Actualizar stock_shopify en Supabase
        await supabase.from('productos')
          .update({ stock_shopify: p.stock_dep })
          .eq('sku', p.sku);

        resultados.push({ sku: p.sku, nombre: p.nombre, stock: p.stock_dep });
        console.log(`✅ ${p.sku} → ${p.stock_dep}`);

      } catch (err) {
        errores.push({ sku: p.sku, error: err.message });
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
    console.error('Error en sync-stock:', err);
    res.status(500).json({ error: err.message });
  }
};
