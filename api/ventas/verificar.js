// api/ventas/verificar.js
// GET /api/ventas/verificar?dias=30
// Compara las órdenes pagadas de MELI y Shopify contra la tabla `ventas` para
// detectar ventas que quedaron fuera del alcance automático (webhook perdido,
// notificación fallida, producto sin vincular al momento de la venta, etc.)

const { getMeliToken } = require('../_meliToken');
const { getShopifyToken } = require('../_shopifyToken');
const { getSupabase } = require('../_supabase');

const SHOP = 'martinez-motos.myshopify.com';
const MAX_PAGINAS = 10;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 90);
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

  const supabase = getSupabase();

  // IDs ya registrados (como venta) o ya resueltos (cancelados) — cualquiera de
  // los dos significa que esa venta puntual ya pasó por el CRM.
  const [{ data: ventasRows }, { data: canceladasRows }] = await Promise.all([
    supabase.from('ventas').select('id'),
    supabase.from('ventas_canceladas').select('venta_id'),
  ]);
  const idsConocidos = new Set([
    ...(ventasRows || []).map((v) => v.id),
    ...(canceladasRows || []).map((v) => v.venta_id),
  ]);

  const [meli, shopify] = await Promise.all([
    verificarMeli(desde, idsConocidos),
    verificarShopify(desde, idsConocidos),
  ]);

  return res.json({
    ok: true,
    dias,
    meli,
    shopify,
    total_faltantes: meli.faltantes.length + shopify.faltantes.length,
  });
};

async function verificarMeli(desde, idsConocidos) {
  const faltantes = [];
  let revisadas = 0;

  try {
    const token = await getMeliToken();
    const meRes = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const me = await meRes.json();
    if (!me.id) throw new Error('No se pudo identificar la cuenta de MELI');

    const desdeStr = desde.toISOString().replace('Z', '-00:00');

    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      const offset = pagina * 50;
      const url = `https://api.mercadolibre.com/orders/search?seller=${me.id}&order.status=paid` +
        `&order.date_created.from=${encodeURIComponent(desdeStr)}` +
        `&sort=date_desc&limit=50&offset=${offset}`;
      const searchRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const search = await searchRes.json();
      const results = search.results || [];
      if (results.length === 0) break;

      for (const order of results) {
        const fechaOrden = new Date(order.date_created);
        if (fechaOrden < desde) continue;
        revisadas++;

        for (const item of order.order_items || []) {
          const meliItemId = item.item?.id;
          if (!meliItemId) continue;
          const ventaId = `V_MELI_${order.id}_${meliItemId}`;
          if (idsConocidos.has(ventaId)) continue;

          faltantes.push({
            canal: 'meli',
            ventaId,
            orden: String(order.id),
            fecha: order.date_created?.slice(0, 10) || null,
            comprador: order.buyer?.nickname || '',
            producto: item.item?.title || meliItemId,
            cantidad: item.quantity,
            precio_unit: item.unit_price,
            total: (item.unit_price || 0) * (item.quantity || 0),
          });
        }
      }

      if (results.length < 50) break;
    }

    return { ok: true, revisadas, faltantes };
  } catch (err) {
    return { ok: false, error: err.message, revisadas, faltantes };
  }
}

async function verificarShopify(desde, idsConocidos) {
  const faltantes = [];
  let revisadas = 0;

  try {
    const token = await getShopifyToken();
    let url = `https://${SHOP}/admin/api/2024-01/orders.json?status=any&financial_status=paid` +
      `&created_at_min=${encodeURIComponent(desde.toISOString())}&limit=250` +
      `&fields=id,order_number,created_at,line_items,customer,email`;

    for (let pagina = 0; pagina < MAX_PAGINAS && url; pagina++) {
      const ordersRes = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!ordersRes.ok) throw new Error(`Shopify respondió ${ordersRes.status}`);
      const { orders } = await ordersRes.json();
      if (!orders || orders.length === 0) break;

      for (const order of orders) {
        revisadas++;
        const comprador = `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() || order.email || '';

        for (const item of order.line_items || []) {
          const variantId = String(item.variant_id);
          const ventaId = `V_SHOP_${order.id}_${variantId}`;
          if (idsConocidos.has(ventaId)) continue;

          faltantes.push({
            canal: 'shopify',
            ventaId,
            orden: String(order.id),
            orden_numero: order.order_number,
            fecha: order.created_at?.slice(0, 10) || null,
            comprador,
            producto: item.title || item.name || variantId,
            cantidad: item.quantity,
            precio_unit: parseFloat(item.price) || 0,
            total: (parseFloat(item.price) || 0) * (item.quantity || 0),
          });
        }
      }

      const linkHeader = ordersRes.headers.get('link') || '';
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = nextMatch ? nextMatch[1] : null;
    }

    return { ok: true, revisadas, faltantes };
  } catch (err) {
    return { ok: false, error: err.message, revisadas, faltantes };
  }
}
