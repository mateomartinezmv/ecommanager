// api/shopify/buscar-sku.js
// GET /api/shopify/buscar-sku?sku=DOM00
// Busca en Shopify el variant_id que coincide EXACTAMENTE con el SKU dado

const { getShopifyToken } = require('../_shopifyToken');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { sku } = req.query;
  if (!sku) return res.status(400).json({ error: 'Falta ?sku=' });

  try {
    const token = await getShopifyToken();
    const shop = process.env.SHOPIFY_SHOP || 'martinez-motos.myshopify.com';

    // Paginar todos los productos y buscar el variant con SKU exacto
    let pageInfo = null;
    let found = null;

    do {
      const url = pageInfo
        ? `https://${shop}/admin/api/2024-01/products.json?limit=250&fields=id,title,variants&page_info=${pageInfo}`
        : `https://${shop}/admin/api/2024-01/products.json?limit=250&fields=id,title,variants`;

      const r = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': token },
      });

      // Extraer link para paginación
      const linkHeader = r.headers.get('link') || '';
      const nextMatch = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
      pageInfo = nextMatch ? nextMatch[1] : null;

      const data = await r.json();
      const products = data.products || [];

      for (const product of products) {
        for (const variant of product.variants || []) {
          if (variant.sku === sku) {
            found = {
              variant_id: String(variant.id),
              product_id: String(product.id),
              producto: product.title,
              variante: variant.title === 'Default Title' ? '—' : variant.title,
              sku: variant.sku,
            };
            break;
          }
        }
        if (found) break;
      }

      if (found) break;

    } while (pageInfo);

    if (!found) {
      return res.json({ found: false });
    }

    return res.json({ found: true, ...found });

  } catch (err) {
    console.error('Error buscando SKU en Shopify:', err);
    return res.status(500).json({ error: err.message });
  }
};
