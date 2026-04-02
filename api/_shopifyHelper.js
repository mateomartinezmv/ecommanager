// api/_shopifyHelper.js
// Helper centralizado para operaciones con la Admin API de Shopify (2026-01)
//
// IMPORTANTE: Si la columna shopify_variant_id no existe en la tabla productos,
// ejecutar en el SQL Editor de Supabase:
//   ALTER TABLE productos ADD COLUMN IF NOT EXISTS shopify_variant_id TEXT;

const SHOPIFY_API_VERSION = '2026-01';

/**
 * Actualiza el stock de un variant en Shopify via Inventory Levels API.
 * Flujo: variant → inventory_item_id → location_id → set inventory level
 */
async function updateShopifyStock(variantId, newQty) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!domain || !token) {
    console.warn('⚠️ Shopify: SHOPIFY_STORE_DOMAIN o SHOPIFY_ACCESS_TOKEN no definidos — omitiendo sync');
    return;
  }

  // 1. Obtener inventory_item_id desde el variant
  const varRes = await fetch(
    `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/variants/${variantId}.json`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );
  const varData = await varRes.json();
  if (!varData.variant) throw new Error(`Shopify: variant ${variantId} no encontrado`);
  const inventoryItemId = varData.variant.inventory_item_id;

  // 2. Obtener location_id (primera ubicación activa)
  const locRes = await fetch(
    `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/locations.json`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );
  const locData = await locRes.json();
  const locationId = locData.locations?.[0]?.id;
  if (!locationId) throw new Error('Shopify: no se encontró ubicación');

  // 3. Setear el nivel de inventario
  const setRes = await fetch(
    `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels/set.json`,
    {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location_id: locationId,
        inventory_item_id: inventoryItemId,
        available: newQty,
      }),
    }
  );
  const setData = await setRes.json();
  if (setData.errors) throw new Error('Shopify inventory set error: ' + JSON.stringify(setData.errors));

  return setData;
}

/**
 * Obtiene un variant de Shopify por su ID.
 * Retorna el objeto variant o null si no existe.
 */
async function getShopifyVariantByShopifyId(shopifyVariantId) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  const res = await fetch(
    `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/variants/${shopifyVariantId}.json`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );
  const data = await res.json();
  return data.variant || null;
}

module.exports = { updateShopifyStock, getShopifyVariantByShopifyId };
