// api/_stockSync.js
// Helpers compartidos para sincronizar stock_dep con MELI y Shopify.

const { getMeliToken } = require('./_meliToken');
const { getShopifyToken } = require('./_shopifyToken');
const { meliIdsDe } = require('./_meliIds');

const SHOPIFY_SHOP = 'martinez-motos.myshopify.com';

async function syncMeliStock(token, meliId, cantidad) {
  const meliRes = await fetch(`https://api.mercadolibre.com/items/${meliId}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ available_quantity: cantidad }),
  });
  const meliData = await meliRes.json();
  if (meliData.error) throw new Error(meliData.message);
  return meliData;
}

// Empuja el mismo stock a TODAS las publicaciones del producto: cada
// publicación lleva su propio available_quantity y todas venden del mismo
// depósito. Un fallo en una no frena a las demás; se devuelven los errores.
async function syncMeliStockProducto(token, producto, cantidad) {
  const ids = meliIdsDe(producto);
  const sincronizadas = [];
  const errores = [];

  for (const meliId of ids) {
    try {
      await syncMeliStock(token, meliId, cantidad);
      sincronizadas.push(meliId);
    } catch (err) {
      errores.push({ meliId, error: err.message });
    }
  }

  return { sincronizadas, errores };
}

async function syncShopifyStock(token, shopifyId, cantidad) {
  // shopifyId puede ser un variant_id; resolvemos su inventory_item_id
  const variantRes = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2024-01/variants/${shopifyId}.json`, {
    headers: { 'X-Shopify-Access-Token': token },
  });
  const variantData = await variantRes.json();
  if (!variantData.variant) throw new Error('Variant no encontrado: ' + shopifyId);

  const inventoryItemId = variantData.variant.inventory_item_id;

  const locRes = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2024-01/locations.json`, {
    headers: { 'X-Shopify-Access-Token': token },
  });
  const locData = await locRes.json();
  const locationId = locData.locations?.[0]?.id;
  if (!locationId) throw new Error('No se encontró ubicación en Shopify');

  const setRes = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2024-01/inventory_levels/set.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available: cantidad }),
  });
  const setData = await setRes.json();
  if (setData.errors) throw new Error(JSON.stringify(setData.errors));
  return setData;
}

// Suma stock_dep (y espeja stock_meli/stock_shopify) para cada ítem de una
// importación que acaba de llegar. No lanza excepción por producto: acumula
// errores/no-encontrados para que un SKU con problemas no bloquee al resto.
async function applyImportArrival(supabase, items) {
  const aplicados = [];
  const noEncontrados = [];
  const errores = [];

  // Suma cantidades por SKU (por si el mismo SKU aparece en varios ítems)
  const qtyBySku = {};
  for (const it of (items || [])) {
    const sku = (it.sku || '').trim();
    const qty = Number(it.qty || it.quantity_ordered || 0);
    if (!sku || !qty) continue;
    qtyBySku[sku] = (qtyBySku[sku] || 0) + qty;
  }

  const skus = Object.keys(qtyBySku);
  if (!skus.length) return { aplicados, noEncontrados, errores };

  const { data: productos, error } = await supabase
    .from('productos')
    .select('sku, stock_dep, meli_id, meli_ids, shopify_id')
    .in('sku', skus);
  if (error) throw error;

  const porSku = {};
  for (const p of (productos || [])) porSku[p.sku] = p;

  let meliToken = null;
  let shopifyToken = null;

  for (const sku of skus) {
    const qty = qtyBySku[sku];
    const p = porSku[sku];
    if (!p) { noEncontrados.push(sku); continue; }

    const nuevoStock = (p.stock_dep || 0) + qty;

    const { error: updErr } = await supabase.from('productos').update({
      stock_dep: nuevoStock,
      stock_meli: nuevoStock,
      stock_shopify: nuevoStock,
    }).eq('sku', sku);
    if (updErr) { errores.push({ sku, error: updErr.message }); continue; }

    aplicados.push({ sku, sumado: qty, nuevoStock });

    if (meliIdsDe(p).length) {
      try {
        if (!meliToken) meliToken = await getMeliToken();
        const r = await syncMeliStockProducto(meliToken, p, nuevoStock);
        for (const e of r.errores) errores.push({ sku, error: `MELI ${e.meliId}: ${e.error}` });
      } catch (err) {
        errores.push({ sku, error: 'MELI: ' + err.message });
      }
    }

    if (p.shopify_id) {
      try {
        if (!shopifyToken) shopifyToken = await getShopifyToken();
        await syncShopifyStock(shopifyToken, p.shopify_id, nuevoStock);
      } catch (err) {
        errores.push({ sku, error: 'Shopify: ' + err.message });
      }
    }
  }

  return { aplicados, noEncontrados, errores };
}

module.exports = { applyImportArrival, syncMeliStock, syncMeliStockProducto, syncShopifyStock };
