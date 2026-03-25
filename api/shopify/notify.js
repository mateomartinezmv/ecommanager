// api/shopify/notify.js
// POST /api/shopify/notify           → webhook orders/paid de Shopify
// GET  /api/shopify/notify?orden=ID  → reprocesar manualmente una orden

const { getSupabase } = require('../_supabase');
const { getMeliToken } = require('../_meliToken');
const { getShopifyToken } = require('../_shopifyToken');

const SHOP = 'martinez-motos.myshopify.com';

async function procesarOrden(order, supabase, log) {
  const resultados = [];
  for (const item of order.line_items) {
    const variantId = String(item.variant_id);
    const cantidad = item.quantity;
    if (log) log.push(`Item: variant ${variantId}, x${cantidad}, $${item.price}`);

    const { data: producto } = await supabase
      .from('productos').select('*').eq('shopify_id', variantId).single();

    if (!producto) {
      const msg = `⚠️ Variante ${variantId} no encontrada en CRM`;
      console.log(msg);
      if (log) log.push(msg);
      resultados.push({ variant: variantId, error: 'Producto no encontrado' });
      continue;
    }
    if (log) log.push(`✅ Producto: ${producto.sku} - ${producto.nombre}`);

    const nuevoStockDep = Math.max(0, producto.stock_dep - cantidad);

    await supabase.from('productos').update({
      stock_dep: nuevoStockDep,
      stock_meli: nuevoStockDep,
      stock_shopify: nuevoStockDep,
      updated_at: new Date().toISOString(),
    }).eq('sku', producto.sku);
    if (log) log.push(`✅ Stock: ${nuevoStockDep}`);

    const ventaId = `V_SHOP_${order.id}_${variantId}`;
    const { data: ventaExistente } = await supabase.from('ventas').select('id').eq('id', ventaId).single();
    if (ventaExistente) {
      const msg = `ℹ️ Venta ${ventaId} ya existe`;
      if (log) log.push(msg);
      resultados.push({ variant: variantId, estado: 'ya_existe', ventaId });
      continue;
    }

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
    console.log(`✅ Venta Shopify registrada: orden ${order.id}, ${producto.nombre} x${cantidad}`);
    if (log) log.push(`✅ Venta registrada: ${ventaId}`);

    // ── Sync → MELI ──
    if (producto.meli_id) {
      try {
        const token = await getMeliToken();
        const meliRes = await fetch(`https://api.mercadolibre.com/items/${producto.meli_id}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ available_quantity: nuevoStockDep }),
        });
        const meliData = await meliRes.json();
        if (meliData.error) { const w = `⚠️ MELI sync error: ${meliData.message}`; console.warn(w); if (log) log.push(w); }
        else { const ok = `✅ MELI sync: ${producto.meli_id} → ${nuevoStockDep}`; console.log(ok); if (log) log.push(ok); }
      } catch (meliErr) {
        const e = `❌ Error sync MELI: ${meliErr.message}`; console.error(e); if (log) log.push(e);
      }
    }

    resultados.push({ variant: variantId, estado: 'registrada', ventaId, sku: producto.sku });
  }
  return resultados;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // GET ?orden=ID → reprocesar manualmente
  if (req.method === 'GET') {
    const orderId = req.query.orden;
    if (!orderId) return res.status(400).json({ error: 'Falta ?orden=ORDER_ID' });
    const log = [];
    try {
      const token = await getShopifyToken();
      log.push('✅ Token Shopify OK');
      const orderRes = await fetch(`https://${SHOP}/admin/api/2024-01/orders/${orderId}.json`, {
        headers: { 'X-Shopify-Access-Token': token },
      });
      if (!orderRes.ok) throw new Error(`Orden ${orderId} no encontrada (${orderRes.status})`);
      const { order } = await orderRes.json();
      log.push(`✅ Orden #${order.order_number}, ${order.line_items.length} item(s), estado: ${order.financial_status}`);
      const supabase = getSupabase();
      const resultados = await procesarOrden(order, supabase, log);
      return res.json({ ok: true, log, resultados });
    } catch (err) {
      log.push(`❌ ${err.message}`);
      return res.status(500).json({ ok: false, log, error: err.message });
    }
  }

  // POST → webhook de Shopify
  if (req.method === 'POST') {
    try {
      let order = req.body;
      if (typeof order === 'string') { try { order = JSON.parse(order); } catch(_) {} }
      if (Buffer.isBuffer(order)) { try { order = JSON.parse(order.toString()); } catch(_) {} }
      if (!order || !order.line_items) {
        console.warn('⚠️ shopify/notify: body vacío o sin line_items', typeof order);
        return res.status(200).json({ ok: true });
      }
      const supabase = getSupabase();
      await procesarOrden(order, supabase, null);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Error en /api/shopify/notify:', err.message);
      return res.status(200).json({ ok: true }); // Siempre 200 para que Shopify no reintente
    }
  }

  return res.status(200).json({ ok: true });
};
