// api/meli/notify.js
// POST /api/meli/notify → recibe notificaciones de MELI (ventas, stock)

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  // MELI espera un 200 rápido
  res.status(200).json({ ok: true });
  if (req.method !== 'POST') return;

  const { topic, resource } = req.body || {};
  console.log('MELI notify:', topic, resource);

  try {
    if (topic === 'orders_v2' || topic === 'orders') {
      await handleOrder(resource);
    } else if (topic === 'payments') {
      // payments resource es /collections/PAYMENT_ID → buscar la orden asociada
      const paymentId = resource.replace('/collections/', '').split('/')[0];
      const token = await getMeliToken();
      const payRes = await fetch(`https://api.mercadolibre.com/collections/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const pay = await payRes.json();
      if (pay.collection?.order_id) {
        await handleOrder(`/orders/${pay.collection.order_id}`);
      }
    }
  } catch (err) {
    console.error('Error procesando notificación MELI:', err.message);
  }
};

async function handleOrder(resource) {
  const token = await getMeliToken();
  const supabase = getSupabase();

  const orderId = resource.replace('/orders/', '').split('/')[0];
  const orderRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const order = await orderRes.json();
  if (order.error) throw new Error(order.message);
  if (order.status !== 'paid') return;

  for (const item of order.order_items) {
    const meliItemId = item.item.id;
    const cantidad = item.quantity;

    const { data: producto } = await supabase
      .from('productos')
      .select('*')
      .eq('meli_id', meliItemId)
      .single();

    if (!producto) {
      console.log(`⚠️ Producto con MELI ID ${meliItemId} no encontrado`);
      continue;
    }

    const nuevoStockDep = Math.max(0, producto.stock_dep - cantidad);
    const nuevoStockMeli = Math.max(0, producto.stock_meli - cantidad);

    // Actualizar CRM
    await supabase.from('productos').update({
      stock_dep: nuevoStockDep,
      stock_meli: nuevoStockMeli,
      updated_at: new Date().toISOString(),
    }).eq('sku', producto.sku);

    // Registrar venta (evitar duplicados)
    const ventaId = `V_MELI_${order.id}_${meliItemId}`;
    const { data: ventaExistente } = await supabase
      .from('ventas').select('id').eq('id', ventaId).single();

    if (!ventaExistente) {
      await supabase.from('ventas').insert({
        id: ventaId,
        canal: 'meli',
        fecha: order.date_created?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        orden_meli: String(order.id),
        comprador: order.buyer?.nickname || '',
        sku: producto.sku,
        producto: producto.nombre,
        cantidad,
        precio_unit: item.unit_price,
        comision: 0,
        total: item.unit_price * cantidad,
        estado: 'pagada',
        genera_envio: true,
      });
      console.log(`✅ Venta MELI registrada: orden ${order.id}, ${producto.nombre} x${cantidad}`);
    }

    // ── Sync → Shopify ──
    if (producto.shopify_id) {
      try {
        await syncShopifyStock(producto.shopify_id, nuevoStockDep);
        console.log(`✅ Shopify sync tras venta MELI: variant ${producto.shopify_id} → ${nuevoStockDep}`);
      } catch (shopErr) {
        console.error('❌ Error sync Shopify tras venta MELI:', shopErr.message);
      }
    }
  }
}

async function syncShopifyStock(variantId, quantity) {
  const shop = process.env.SHOPIFY_STORE_URL;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!shop || !token) return;

  const locRes = await fetch(`https://${shop}/admin/api/2024-01/locations.json`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  const locData = await locRes.json();
  const locationId = locData.locations?.[0]?.id;
  if (!locationId) throw new Error('No location en Shopify');

  const varRes = await fetch(`https://${shop}/admin/api/2024-01/variants/${variantId}.json`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  const varData = await varRes.json();
  const inventoryItemId = varData.variant?.inventory_item_id;
  if (!inventoryItemId) throw new Error(`Variant ${variantId} no encontrado`);

  const setRes = await fetch(`https://${shop}/admin/api/2024-01/inventory_levels/set.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available: quantity }),
  });
  const setData = await setRes.json();
  if (setData.errors) throw new Error(JSON.stringify(setData.errors));
}
