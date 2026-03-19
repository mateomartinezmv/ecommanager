// api/productos.js
// GET  /api/productos        → listar todos
// POST /api/productos        → crear
// PUT  /api/productos?sku=XX → actualizar (sincroniza stock con MELI y Shopify si aplica)
// DELETE /api/productos?sku=XX → eliminar

const { getSupabase } = require('./_supabase');
const { getMeliToken } = require('./_meliToken');
const { getShopifyToken } = require('./_shopifyToken');

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
        tipo: p.tipo || 'nuevo',
        stock_dep: p.stockDep || 0,
        stock_meli: p.stockMeli || 0,
        stock_shopify: p.stockShopify || 0,
        costo: p.costo || 0, precio: p.precio,
        alerta_min: p.alertaMin || 5,
        meli_id: p.meliId || null,
        shopify_id: p.shopifyId || null,
        notas: p.notas,
      }).select().single();
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'PUT') {
      const sku = req.query.sku;
      const p = req.body;

      // Obtener producto anterior para comparar stock
      const { data: anterior } = await supabase
        .from('productos')
        .select('stock_meli, stock_shopify, meli_id, shopify_id')
        .eq('sku', sku)
        .single();

// Construir objeto de update solo con campos presentes
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
// shopify_id, shopify_handle, stock_shopify NUNCA se pisan desde este endpoint
updateFields.updated_at = new Date().toISOString();

const { data, error } = await supabase.from('productos').update(updateFields)
  .eq('sku', sku).select().single();

      const meliId = p.meliId || anterior?.meli_id;
      const shopifyId = p.shopifyId || anterior?.shopify_id;

      // Sincronizar stock MELI si cambió
      if (meliId && anterior && anterior.stock_meli !== p.stockMeli) {
        try {
          const token = await getMeliToken();
          const meliRes = await fetch(`https://api.mercadolibre.com/items/${meliId}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ available_quantity: p.stockMeli }),
          });
          const meliData = await meliRes.json();
          if (meliData.error) console.warn('⚠️ MELI stock sync warning:', meliData.message);
          else console.log(`✅ Stock MELI sincronizado: ${meliId} → ${p.stockMeli}`);
        } catch (meliErr) {
          console.error('❌ Error sincronizando stock MELI:', meliErr.message);
        }
      }

      // Sincronizar stock Shopify si cambió
      if (shopifyId && anterior && anterior.stock_shopify !== p.stockShopify) {
        try {
          await syncShopifyStock(shopifyId, p.stockShopify);
        } catch (shopErr) {
          console.error('❌ Error sincronizando stock Shopify:', shopErr.message);
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

// Sincronizar stock en Shopify via Inventory API
async function syncShopifyStock(shopifyId, cantidad) {
  const SHOP = 'martinez-motos.myshopify.com';
  const token = await getShopifyToken();

  // shopifyId puede ser un variant_id o inventory_item_id
  // Primero obtenemos el inventory_item_id del variant
  const variantRes = await fetch(`https://${SHOP}/admin/api/2024-01/variants/${shopifyId}.json`, {
    headers: { 'X-Shopify-Access-Token': token },
  });
  const variantData = await variantRes.json();
  if (!variantData.variant) throw new Error('Variant no encontrado: ' + shopifyId);

  const inventoryItemId = variantData.variant.inventory_item_id;

  // Obtener location_id (usamos la primera ubicación)
  const locRes = await fetch(`https://${SHOP}/admin/api/2024-01/locations.json`, {
    headers: { 'X-Shopify-Access-Token': token },
  });
  const locData = await locRes.json();
  const locationId = locData.locations?.[0]?.id;
  if (!locationId) throw new Error('No se encontró ubicación en Shopify');

  // Ajustar inventario
  const setRes = await fetch(`https://${SHOP}/admin/api/2024-01/inventory_levels/set.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available: cantidad,
    }),
  });
  const setData = await setRes.json();
  if (setData.errors) throw new Error(JSON.stringify(setData.errors));

  console.log(`✅ Stock Shopify sincronizado: variant ${shopifyId} → ${cantidad}`);
  return setData;
}
