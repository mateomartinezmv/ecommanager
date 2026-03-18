// api/shopify/notify.js
// POST /api/shopify/notify → recibe webhooks de Shopify (orders/paid)
// Configurar en Shopify Admin → Settings → Notifications → Webhooks
// Evento: "Order payment" → URL: https://TU-DOMINIO.vercel.app/api/shopify/notify

const { getSupabase } = require('../_supabase');
const crypto = require('crypto');

module.exports = async (req, res) => {
  // Shopify requiere respuesta 200 inmediata
  res.status(200).json({ ok: true });
  if (req.method !== 'POST') return;

  // Verificar firma HMAC para seguridad (evita requests falsos)
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (secret && hmacHeader) {
    const body = JSON.stringify(req.body);
    const digest = crypto.createHmac('sha256', secret).update(body).digest('base64');
    if (digest !== hmacHeader) {
      console.warn('⚠️ Webhook Shopify con firma inválida — ignorado');
      return;
    }
  }

  const topic = req.headers['x-shopify-topic'];
  console.log('Shopify webhook:', topic);

  try {
    if (topic === 'orders/paid' || topic === 'orders/create') {
      await handleOrderPaid(req.body);
    }
  } catch (err) {
    console.error('Error procesando webhook Shopify:', err.message);
  }
};

async function handleOrderPaid(order) {
  const supabase = getSupabase();
  const lineItems = order.line_items || [];

  for (const item of lineItems) {
    const sku = item.sku;
    const cantidad = item.quantity;

    if (!sku) {
      console.log(`⚠️ Item sin SKU: ${item.title}`);
      continue;
    }

    // Buscar producto por SKU
    const { data: producto, error } = await supabase
      .from('productos')
      .select('*')
      .eq('sku', sku)
      .single();

    if (error || !producto) {
      console.log(`⚠️ SKU no encontrado en CRM: ${sku}`);
      continue;
    }

    // Descontar stock
    const nuevoStockDep     = Math.max(0, producto.stock_dep - cantidad);
    const nuevoStockShopify = Math.max(0, (producto.stock_shopify || 0) - cantidad);

    await supabase.from('productos').update({
      stock_dep:      nuevoStockDep,
      stock_shopify:  nuevoStockShopify,
      updated_at:     new Date().toISOString(),
    }).eq('sku', sku);

    // Registrar la venta en la tabla ventas
    const ventaId = `V_SHOP_${order.id}_${item.id}`;
    const { data: ventaExistente } = await supabase
      .from('ventas')
      .select('id')
      .eq('id', ventaId)
      .single();

    if (!ventaExistente) {
      await supabase.from('ventas').insert({
        id:          ventaId,
        canal:       'shopify',
        fecha:       order.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        orden_meli:  String(order.order_number),
        comprador:   order.customer
                       ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim()
                       : order.email || '',
        sku:         producto.sku,
        producto:    producto.nombre,
        cantidad,
        precio_unit: parseFloat(item.price),
        comision:    0,
        total:       parseFloat(item.price) * cantidad,
        estado:      'pagada',
        genera_envio: true,
        notas:       `Shopify orden #${order.order_number}`,
      });

      console.log(`✅ Venta Shopify registrada: orden #${order.order_number} | ${producto.nombre} x${cantidad}`);
    }
  }
}
