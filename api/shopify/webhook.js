// api/shopify/webhook.js
// POST /api/shopify/webhook → recibe notificaciones de Shopify
// Valida HMAC, procesa orders/paid descontando stock y sincronizando con MELI

const crypto = require('crypto');
const { getSupabase } = require('../_supabase');
const { getMeliToken } = require('../_meliToken');
const { updateShopifyStock } = require('../_shopifyHelper');

// Deshabilitar body parser de Vercel para leer el raw buffer (necesario para HMAC)
module.exports.config = {
  api: { bodyParser: false },
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Leer raw body como buffer
  const rawBody = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  // Validar firma HMAC
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];

  if (!secret || !hmacHeader) {
    console.warn('⚠️ Shopify webhook: falta SHOPIFY_WEBHOOK_SECRET o header X-Shopify-Hmac-Sha256');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const bodyForHmac = rawBody.length > 0 ? rawBody : Buffer.from(JSON.stringify(req.body || {}));
  const calculatedHmac = crypto
    .createHmac('sha256', secret)
    .update(bodyForHmac)
    .digest('base64');

  if (calculatedHmac !== hmacHeader) {
    console.warn('⚠️ Shopify webhook: HMAC inválido — posible request no autorizado');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const topic = req.headers['x-shopify-topic'];
  console.log('📦 Shopify webhook recibido:', topic);

  // Responder 200 inmediatamente (Shopify requiere respuesta rápida)
  res.status(200).json({ ok: true });

  // Procesar en background
  try {
    const body = JSON.parse(rawBody.toString('utf8'));

    if (topic === 'orders/paid') {
      await handleOrderPaid(body);
    } else {
      console.log(`ℹ️ Shopify webhook topic recibido (no procesado): ${topic}`);
    }
  } catch (err) {
    console.error('❌ Error procesando webhook Shopify:', err.message);
  }
};

async function handleOrderPaid(order) {
  const supabase = getSupabase();

  for (const item of order.line_items || []) {
    const variantId = item.variant_id;
    if (!variantId) continue;

    const { data: producto } = await supabase
      .from('productos')
      .select('*')
      .eq('shopify_variant_id', String(variantId))
      .single();

    if (!producto) {
      console.warn(`⚠️ Shopify webhook: variant_id ${variantId} no encontrado en productos — omitiendo`);
      continue;
    }

    const cantidad = item.quantity || 1;
    const nuevoStockDep = Math.max(0, producto.stock_dep - cantidad);

    await supabase.from('productos').update({
      stock_dep: nuevoStockDep,
      stock_shopify: nuevoStockDep,
      updated_at: new Date().toISOString(),
    }).eq('sku', producto.sku);

    // Registrar venta evitando duplicados
    const ventaId = `V_SHOPIFY_${order.id}_${variantId}`;
    const { data: ventaExistente } = await supabase.from('ventas').select('id').eq('id', ventaId).single();

    if (!ventaExistente) {
      const comprador = order.customer
        ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim()
        : '';
      const { error: ventaErr } = await supabase.from('ventas').insert({
        id: ventaId,
        canal: 'shopify',
        fecha: order.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        comprador: comprador || null,
        sku: producto.sku,
        producto: producto.nombre,
        cantidad,
        precio_unit: parseFloat(item.price) || 0,
        comision: 0,
        total: (parseFloat(item.price) || 0) * cantidad,
        estado: 'pagada',
        genera_envio: false,
      });
      if (ventaErr) {
        console.error(`❌ Error insertando venta Shopify ${ventaId}:`, ventaErr.message);
      } else {
        console.log(`✅ Venta Shopify registrada: ${ventaId}`);
      }
    }

    // Sincronizar stock resultante con MELI si el producto tiene meli_id
    if (producto.meli_id) {
      try {
        const token = await getMeliToken();
        const meliRes = await fetch(`https://api.mercadolibre.com/items/${producto.meli_id}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ available_quantity: nuevoStockDep }),
        });
        const meliData = await meliRes.json();
        if (meliData.error) console.warn(`⚠️ MELI sync error para ${producto.meli_id}:`, meliData.message);
        else console.log(`✅ Stock MELI sincronizado desde Shopify webhook: ${producto.meli_id} → ${nuevoStockDep}`);
      } catch (meliErr) {
        console.error('❌ Error sincronizando MELI desde webhook Shopify:', meliErr.message);
      }
    }
  }
}
