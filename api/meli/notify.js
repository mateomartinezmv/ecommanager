// api/meli/notify.js
// POST /api/meli/notify → recibe notificaciones de MELI (ventas, stock)

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  // MELI espera un 200 rápido, siempre responder primero
  res.status(200).json({ ok: true });

  if (req.method !== 'POST') return;

  const { topic, resource, user_id } = req.body || {};
  console.log('MELI notify:', topic, resource);

  try {
    if (topic === 'orders_v2' || topic === 'orders') {
      await handleOrder(resource);
    }
    // Podés agregar más topics acá (payments, questions, etc.)
  } catch (err) {
    console.error('Error procesando notificación MELI:', err.message);
  }
};

async function handleOrder(resource) {
  const token = await getMeliToken();
  const supabase = getSupabase();

  // Obtener detalle de la orden
  const orderId = resource.replace('/orders/', '').split('/')[0];
  const orderRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const order = await orderRes.json();
  if (order.error) throw new Error(order.message);

  // Solo procesar órdenes pagadas
  if (order.status !== 'paid') return;

  for (const item of order.order_items) {
    const meliItemId = item.item.id;
    const cantidad = item.quantity;

    // Buscar el producto por meli_id
    const { data: producto } = await supabase
      .from('productos')
      .select('*')
      .eq('meli_id', meliItemId)
      .single();

    if (!producto) {
      console.log(`Producto con MELI ID ${meliItemId} no encontrado en DB`);
      continue;
    }

    // Descontar stock
    const nuevoStockDep = Math.max(0, producto.stock_dep - cantidad);
    const nuevoStockMeli = Math.max(0, producto.stock_meli - cantidad);

    await supabase.from('productos').update({
      stock_dep: nuevoStockDep,
      stock_meli: nuevoStockMeli,
      updated_at: new Date().toISOString(),
    }).eq('sku', producto.sku);

    // Registrar la venta automáticamente
    const ventaId = 'V_MELI_' + order.id + '_' + item.item.id;
    const { data: ventaExistente } = await supabase
      .from('ventas')
      .select('id')
      .eq('id', ventaId)
      .single();

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

      console.log(`✅ Venta MELI registrada: orden ${order.id}, producto ${producto.nombre}, cantidad ${cantidad}`);
    }
  }
}
