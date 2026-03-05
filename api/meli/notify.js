// api/meli/notify.js
// POST /api/meli/notify → recibe notificaciones de MELI (ventas, stock)
// MELI requiere respuesta 200 inmediata, el procesamiento se hace después

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  // MELI exige un 200 inmediato o reintenta. Respondemos primero.
  res.status(200).json({ ok: true });

  if (req.method !== 'POST') return;

  const body = req.body || {};
  const { topic, resource } = body;

  // Guardar log de la notificación para diagnóstico
  const supabase = getSupabase();
  const logEntry = {
    topic: topic || 'desconocido',
    resource: resource || '',
    raw: JSON.stringify(body),
    recibido_at: new Date().toISOString(),
  };

  try {
    await supabase.from('meli_notify_log').insert(logEntry);
  } catch (_) {
    // La tabla puede no existir, no es crítico
  }

  console.log(`[MELI NOTIFY] topic=${topic} resource=${resource}`);

  if (!topic || !resource) return;

  try {
    if (topic === 'orders_v2' || topic === 'orders') {
      await handleOrder(resource, supabase);
    }
  } catch (err) {
    console.error('[MELI NOTIFY] Error procesando notificación:', err.message);
    try {
      await supabase.from('meli_notify_log').insert({
        ...logEntry,
        error: err.message,
      });
    } catch (_) {}
  }
};

async function handleOrder(resource, supabase) {
  const token = await getMeliToken();

  // El resource puede ser "/orders/123456789" o directamente el ID
  const orderId = String(resource).replace(/\D/g, '').trim();
  if (!orderId) throw new Error('No se pudo extraer el ID de orden del resource: ' + resource);

  console.log(`[MELI NOTIFY] Procesando orden ${orderId}`);

  // Obtener detalle de la orden
  const orderRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const order = await orderRes.json();

  if (order.error) throw new Error(`Error obteniendo orden ${orderId}: ${order.message}`);

  // Solo procesar órdenes pagadas
  if (order.status !== 'paid') {
    console.log(`[MELI NOTIFY] Orden ${orderId} ignorada (estado: ${order.status})`);
    return;
  }

  const items = order.order_items || [];
  console.log(`[MELI NOTIFY] Orden ${orderId} tiene ${items.length} item(s)`);

  for (const item of items) {
    const meliItemId = item.item?.id;
    const cantidad = item.quantity || 1;
    const precioUnit = item.unit_price || 0;

    if (!meliItemId) {
      console.warn('[MELI NOTIFY] Item sin ID, saltando...');
      continue;
    }

    // Buscar el producto por meli_id
    const { data: producto, error: prodErr } = await supabase
      .from('productos')
      .select('*')
      .eq('meli_id', meliItemId)
      .single();

    if (prodErr || !producto) {
      console.warn(`[MELI NOTIFY] Producto con meli_id=${meliItemId} no encontrado. Creando registro automático...`);

      // Auto-crear el producto si no existe, para no perder la venta
      const skuAuto = `MELI-${meliItemId}`;
      const { data: existeAuto } = await supabase.from('productos').select('sku').eq('sku', skuAuto).single();

      if (!existeAuto) {
        // Intentar obtener detalles del item de MELI
        let nombreItem = item.item?.title || `Producto MELI ${meliItemId}`;
        try {
          const itemRes = await fetch(`https://api.mercadolibre.com/items/${meliItemId}`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          const itemData = await itemRes.json();
          if (!itemData.error) nombreItem = itemData.title;
        } catch (_) {}

        await supabase.from('productos').insert({
          sku: skuAuto,
          nombre: nombreItem,
          stock_dep: 0,
          stock_meli: 0,
          costo: 0,
          precio: precioUnit,
          alerta_min: 3,
          meli_id: meliItemId,
          notas: 'Auto-creado por notificación MELI',
        });
        console.log(`[MELI NOTIFY] Producto auto-creado: ${skuAuto}`);
      }

      // Registrar la venta igualmente con el SKU auto-generado
      await registrarVenta({ supabase, order, item, sku: skuAuto, nombreProducto: item.item?.title || skuAuto, cantidad, precioUnit });
      continue;
    }

    // Descontar stock
    const nuevoStockDep  = Math.max(0, producto.stock_dep  - cantidad);
    const nuevoStockMeli = Math.max(0, producto.stock_meli - cantidad);

    await supabase.from('productos').update({
      stock_dep:  nuevoStockDep,
      stock_meli: nuevoStockMeli,
      updated_at: new Date().toISOString(),
    }).eq('sku', producto.sku);

    console.log(`[MELI NOTIFY] Stock actualizado: ${producto.sku} dep=${nuevoStockDep} meli=${nuevoStockMeli}`);

    await registrarVenta({
      supabase, order, item,
      sku: producto.sku,
      nombreProducto: producto.nombre,
      cantidad,
      precioUnit,
    });
  }
}

async function registrarVenta({ supabase, order, item, sku, nombreProducto, cantidad, precioUnit }) {
  // ID único basado en orden + item para evitar duplicados
  const ventaId = `V_MELI_${order.id}_${item.item?.id || Date.now()}`;

  // Verificar si ya fue registrada (idempotencia)
  const { data: ventaExistente } = await supabase
    .from('ventas')
    .select('id')
    .eq('id', ventaId)
    .single();

  if (ventaExistente) {
    console.log(`[MELI NOTIFY] Venta ${ventaId} ya registrada, ignorando duplicado`);
    return;
  }

  const { error } = await supabase.from('ventas').insert({
    id: ventaId,
    canal: 'meli',
    fecha: order.date_created?.slice(0, 10) || new Date().toISOString().slice(0, 10),
    orden_meli: String(order.id),
    comprador: order.buyer?.nickname || order.buyer?.first_name || '',
    sku,
    producto: nombreProducto,
    cantidad,
    precio_unit: precioUnit,
    comision: 0, // MELI no devuelve la comisión en orders, se puede calcular aparte
    total: precioUnit * cantidad,
    estado: 'pagada',
    genera_envio: true,
    notas: `Auto-registrada por webhook MELI`,
  });

  if (error) {
    throw new Error(`Error registrando venta ${ventaId}: ${error.message}`);
  }

  console.log(`[MELI NOTIFY] ✅ Venta registrada: ${ventaId} | ${nombreProducto} x${cantidad} = $${precioUnit * cantidad}`);
}
