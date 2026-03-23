// api/shopify/buscar-sku.js
// GET /api/shopify/buscar-sku?sku=DOM00
// Busca en Shopify el variant_id que coincide con el SKU dado

const { getShopifyToken } = require('../_shopifyToken');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { sku } = req.query;
  if (!sku) return res.status(400).json({ error: 'Falta ?sku=' });

  try {
    const token = await getShopifyToken();
    const shop = process.env.SHOPIFY_SHOP || 'martinez-motos.myshopify.com';

    // Buscar productos que tengan un variant con ese SKU
    const url = `https://${shop}/admin/api/2024-01/variants.json?sku=${encodeURIComponent(sku)}&limit=5`;
    const res2 = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
    });

    const data = await res2.json();
    const variants = data.variants || [];

    if (variants.length === 0) {
      return res.json({ found: false });
    }

    // Tomar el primero (debería ser único por SKU)
    const variant = variants[0];

    // Obtener nombre del producto
    const prodRes = await fetch(`https://${shop}/admin/api/2024-01/products/${variant.product_id}.json?fields=id,title`, {
      headers: { 'X-Shopify-Access-Token': token },
    });
    const prodData = await prodRes.json();
    const titulo = prodData.product?.title || 'Producto desconocido';

    return res.json({
      found: true,
      variant_id: String(variant.id),
      product_id: String(variant.product_id),
      producto: titulo,
      variante: variant.title === 'Default Title' ? '—' : variant.title,
      sku: variant.sku,
    });

  } catch (err) {
    console.error('Error buscando SKU en Shopify:', err);
    return res.status(500).json({ error: err.message });
  }
};
