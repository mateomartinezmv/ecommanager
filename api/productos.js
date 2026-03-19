// api/productos.js
const { getSupabase } = require('./_supabase');
const { getMeliToken } = require('./_meliToken');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('productos')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'POST') {
      const p = req.body;
      const { data, error } = await supabase.from('productos').insert({
        sku: p.sku, nombre: p.nombre, categoria: p.categoria,
        stock_dep: p.stockDep || 0, stock_meli: p.stockMeli || 0,
        costo: p.costo || 0, precio: p.precio,
        alerta_min: p.alertaMin || 5, meli_id: p.meliId, notas: p.notas,
      }).select().single();
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'PUT') {
      const sku = req.query.sku;
      const p = req.body;

      // Obtener producto anterior
      const { data: anterior } = await supabase
        .from('productos')
        .select('*')
        .eq('sku', sku)
        .single();

      // Construir campos a actualizar — NUNCA pisar shopify_id ni shopify_handle
      const updateFields = {};
      if (p.nombre !== undefined)    updateFields.nombre = p.nombre;
      if (p.categoria !== undefined) updateFields.categoria = p.categoria;
      if (p.stockDep !== undefined)  updateFields.stock_dep = p.stockDep;
      if (p.stockMeli !== undefined) updateFields.stock_meli = p.stockMeli;
      if (p.costo !== undefined)     updateFields.costo = p.costo;
      if (p.precio !== undefined)    updateFields.precio = p.precio;
      if (p.alertaMin !== undefined) updateFields.alerta_min = p.alertaMin;
      if (p.meliId !== undefined)    updateFields.meli_id = p.meliId;
      if (p.notas !== undefined)     updateFields.notas = p.notas;
      updateFields.updated_at = new Date().toISOString();

      const { data, error } = await supabase.from('productos')
        .update(updateFields)
        .eq('sku', sku).select().single();
      if (error) throw error;

      const meliId = p.meliId ?? anterior?.meli_id;
      const shopifyId = anterior?.shopify_id;
      const stockMeliCambio = anterior && anterior.stock_meli !== p.stockMeli;
      const stockDepCambio = anterior && anterior.stock_dep !== p.stockDep;

      // ── Sync → MELI ──
      if (meliId && stockMeliCambio) {
        try {
          const token = await getMeliToken();
          const meliRes = await fetch(`https://api.mercadolibre.com/items/${meliId}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ available_quantity: p.stockMeli }),
          });
          const meliData = await meliRes.json();
          if (meliData.error) console.warn('⚠️ MELI sync warning:', meliData.message);
          else console.log(`✅ MELI sync: ${meliId} → ${p.stockMeli}`);
        } catch (meliErr) {
          console.error('❌ Error sync MELI:', meliErr.message);
        }
      }

      // ── Sync → Shopify ──
      if (shopifyId && (stockDepCambio || stockMeliCambio)) {
        try {
          const nuevoStock = p.stockDep !== undefined ? p.stockDep : anterior.stock_dep;
          await syncShopifyStock(shopifyId, nuevoStock);
        } catch (shopErr) {
          console.error('❌ Error sync Shopify:', shopErr.message);
        }
      }

      return res.json(data);
    }

    if (req.method === 'DELETE') {
      const sku = req.query.sku;
      const { error } = await supabase.from('productos').delete().eq('sku', sku);
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/productos:', err);
    res.status(500).json({ error: err.message });
  }
};

// ── Helper: actualizar stock en Shopify ──
async function syncShopifyStock(variantId, quantity) {
  const shop = process.env.SHOPIFY_STORE_URL; // ej: martinez-motos.myshopify.com
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!shop || !token) {
    console.warn('⚠️ Shopify no configurado (faltan env vars)');
    return;
  }

  // 1. Obtener location_id (inventory location)
  const locRes = await fetch(`https://${shop}/admin/api/2024-01/locations.json`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  const locData = await locRes.json();
  const locationId = locData.locations?.[0]?.id;
  if (!locationId) throw new Error('No se encontró location en Shopify');

  // 2. Obtener inventory_item_id de la variante
  const varRes = await fetch(`https://${shop}/admin/api/2024-01/variants/${variantId}.json`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  const varData = await varRes.json();
  const inventoryItemId = varData.variant?.inventory_item_id;
  if (!inventoryItemId) throw new Error(`Variant ${variantId} no encontrado en Shopify`);

  // 3. Setear stock
  const setRes = await fetch(`https://${shop}/admin/api/2024-01/inventory_levels/set.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available: quantity }),
  });
  const setData = await setRes.json();
  if (setData.errors) throw new Error(JSON.stringify(setData.errors));
  console.log(`✅ Shopify sync: variant ${variantId} → ${quantity}`);
}
