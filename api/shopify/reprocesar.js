// api/shopify/reprocesar.js
// GET /api/shopify/reprocesar?orden=ORDER_ID → reprocesa manualmente una orden de Shopify

const { getSupabase } = require('../_supabase');
const { getMeliToken } = require('../_meliToken');
const { getShopifyToken } = require('../_shopifyToken');

const SHOP = 'martinez-motos.myshopify.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const orderId = req.query.orden;
  if (!orderId) return res.status(400).json({ error: 'Falta parámetro ?orden=ORDER_ID' });

  const log = [];
  const resultados = [];

  try {
    const token = await getShopifyToken();
    log.push('✅ Token Shopify OK');

    const orderRes = await fetch(`https://${SHOP}/admin/api/2024-01/orders/${orderId}.json`, {
      headers: { 'X-Shopify-Access-Token': token },
    });
    if (!orderRes.ok) throw new Error(`Orden ${orderId} no encontrada en Shopify (${orderRes.status})`);
    const { order } = await orderRes.json();
    log.push(`✅ Orden encontrada: #${order.order_number}, ${order.line_items.length} item(s), financial_status: ${order.financial_status}`);

    const supabase = getSupabase();

    for (const item of order.line_items) {
      const variantId = String(item.variant_id);
      const cantidad = item.quantity;
      log.push(`Item: variant ${variantId}, x${cantidad}, $${item.price}`);

      const { data: producto } = await supabase
        .from('productos')
        .select('*')
        .eq('shopify_id', variantId)
        .single();

      if (!producto) {
        log.push(`⚠️ Variante ${variantId} no encontrada en CRM`);
        resultados.push({ variant: variantId, error: 'Producto no encontrado' });
        continue;
      }
      log.push(`✅ Producto: ${producto.sku} - ${producto.nombre}`);

      const ventaId = `V_SHOP_${order.id}_${variantId}`;
      const { data: ventaExistente } = await supabase.from('ventas').select('id').eq('id', ventaId).single();
      if (ventaExistente) {
        log.push(`ℹ️ Venta ${ventaId} ya existe`);
        resultados.push({ variant: variantId, estado: 'ya_existe', ventaId });
        continue;
      }

      const nuevoStockDep = Math.max(0, producto.stock_dep - cantidad);
      await supabase.from('productos').update({
        stock_dep: nuevoStockDep,
        stock_meli: nuevoStockDep,
        stock_shopify: nuevoStockDep,
        updated_at: new Date().toISOString(),
      }).eq('sku', producto.sku);
      log.push(`✅ Stock: ${nuevoStockDep}`);

      const { error: ventaErr } = await supabase.from('ventas').insert({
        id: ventaId,
        canal: 'shopify',
        fecha: order.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        orden_meli: null,
        comprador: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() || order.email || '',
        sku: producto.sku,
        producto: producto.nombre,
        cantidad,
        precio_unit: parseFloat(item.price) || 0,
        comision: 0,
        total: parseFloat(item.price) * cantidad,
        estado: 'pagada',
        genera_envio: true,
      });
      if (ventaErr) throw ventaErr;
      log.push(`✅ Venta registrada: ${ventaId}`);

      // ── Sync → MELI ──
      if (producto.meli_id) {
        try {
          const meliToken = await getMeliToken();
          const meliRes = await fetch(`https://api.mercadolibre.com/items/${producto.meli_id}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${meliToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ available_quantity: nuevoStockDep }),
          });
          const meliData = await meliRes.json();
          if (meliData.error) log.push(`⚠️ MELI sync error: ${meliData.message}`);
          else log.push(`✅ MELI sync: ${producto.meli_id} → ${nuevoStockDep}`);
        } catch (meliErr) {
          log.push(`❌ Error sync MELI: ${meliErr.message}`);
        }
      }

      resultados.push({ variant: variantId, estado: 'registrada', ventaId, sku: producto.sku });
    }

    return res.json({ ok: true, log, resultados });
  } catch (err) {
    log.push(`❌ Error: ${err.message}`);
    return res.status(500).json({ ok: false, log, error: err.message });
  }
};
