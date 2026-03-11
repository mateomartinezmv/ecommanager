// api/shopify/notify.js
// POST /api/shopify/notify → recibe webhooks de Shopify (órdenes pagadas)

const { getSupabase } = require('../_supabase');
const crypto = require('crypto');

module.exports = async (req, res) => {
  // Responder 200 rápido a Shopify
  res.status(200).json({ ok: true });

  if (req.method !== 'POST') return;

  try {
    // Verificar que el webhook viene de Shopify
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const topic = req.headers['x-shopify-topic'];
    const body = JSON.stringify(req.body);

    if (process.env.SHOPIFY_CLIENT_SECRET && hmac) {
      const hash = crypto
        .createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET)
        .update(body, 'utf8')
        .digest('base64');
      if (hash !== hmac) {
        console.warn('⚠️ Webhook Shopify con firma inválida');
        return;
      }
    }

    console.log('📦 Shopify webhook recibido:', topic);

    if (topic === 'orders/paid' || topic === 'orders/create') {
      await handleOrder(req.body);
    }

  } catch (err) {
    console.error('Error procesando webhook Shopify:', err.message);
  }
};

async function handleOrder(order) {
  const supabase = getSupabase();

  // Solo procesar órdenes pagadas
  if (order.financial_status !== 'paid' && order.financial_status !== 'partially_paid') {
    console.log(`Orden ${order.id} ignorada — estado: ${order.financial_status}`);
    return;
  }

  for (const item of order.line_items) {
    const sku = item.sku;
    if (!sku) {
      console.log(`Item sin SKU: ${item.title} — omitido`);
      continue;
    }

    // Buscar producto por SKU
    const { data: producto } = await supabase
      .from('productos')
      .select('*')
      .eq('sku', sku)
      .single();

    if (!producto) {
      console.log(`Producto SKU ${sku} no encontrado en DB — omitido`);
      continue;
    }

    const cantidad = item.quantity;
    const nuevoStockDep = Math.max(0, producto.stock_dep - cantidad);

    // Actualizar stock
    await supabase.from('productos').update({
      stock_dep: nuevoStockDep,
      updated_at: new Date().toISOString(),
    }).eq('sku', sku);

    // Registrar venta (evitar duplicados)
    const ventaId = `V_SHOP_${order.id}_${item.id}`;
    const { data: ventaExistente } = await supabase
      .from('ventas')
      .select('id')
      .eq('id', ventaId)
      .single();

    if (!ventaExistente) {
      const precioUnit = parseFloat(item.price);
      const total = precioUnit * cantidad;

      await supabase.from('ventas').insert({
        id: ventaId,
        canal: 'shopify',
        fecha: order.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        orden_meli: String(order.order_number || order.id),
        comprador: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() || order.email || '',
        sku,
        producto: item.title,
        cantidad,
        precio_unit: precioUnit,
        comision: 0,
        total,
        estado: 'pagada',
        genera_envio: order.requires_shipping || false,
        notas: `Shopify orden #${order.order_number}`,
      });

      console.log(`✅ Venta Shopify registrada: orden ${order.order_number}, ${item.title} x${cantidad}`);
    }
  }
}
