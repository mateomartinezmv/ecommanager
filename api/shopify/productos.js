// api/shopify/productos.js
// GET /api/shopify/productos → lista todos los productos de Shopify con variant IDs

const { getShopifyToken } = require('../_shopifyToken');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const SHOP = 'martinez-motos.myshopify.com';

  try {
    const token = await getShopifyToken();

    const response = await fetch(`https://${SHOP}/admin/api/2024-01/products.json?limit=250&fields=id,title,variants`, {
      headers: { 'X-Shopify-Access-Token': token },
    });

    const data = await response.json();
    if (!data.products) throw new Error('No se pudieron obtener productos de Shopify');

    // Aplanar: un registro por variante
    const resultado = [];
    for (const product of data.products) {
      for (const variant of product.variants) {
        resultado.push({
          producto: product.title,
          variant_titulo: variant.title === 'Default Title' ? '—' : variant.title,
          sku: variant.sku || '(sin SKU)',
          variant_id: variant.id,
          inventory_item_id: variant.inventory_item_id,
          precio: variant.price,
          stock: variant.inventory_quantity,
        });
      }
    }

    // Ordenar por nombre de producto
    resultado.sort((a, b) => a.producto.localeCompare(b.producto));

    res.json({
      total: resultado.length,
      productos: resultado,
    });

  } catch (err) {
    console.error('Error listando productos Shopify:', err);
    res.status(500).json({ error: err.message });
  }
};
